import os
import re
import io
import json
import math
import zipfile
import subprocess
import threading
import tempfile
from functools import wraps

from flask import Flask, request, jsonify, render_template, send_file

MAX_PROCESS_STDOUT_BYTES = 1024 * 1024
MAX_PROCESS_STDERR_BYTES = 256 * 1024


class ProcessOutputLimitExceeded(Exception):
    pass


def run_process_bounded(args, *, input_text=None, timeout=30,
                        stdout_limit=MAX_PROCESS_STDOUT_BYTES,
                        stderr_limit=MAX_PROCESS_STDERR_BYTES):
    """Run a child process while bounding captured stdout/stderr memory."""
    process = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0
    )
    buffers = {
        "stdout": bytearray(),
        "stderr": bytearray()
    }
    limits = {
        "stdout": max(0, int(stdout_limit)),
        "stderr": max(0, int(stderr_limit))
    }
    output_limited = threading.Event()

    def drain(name, stream):
        buffer = buffers[name]
        limit = limits[name]
        while True:
            chunk = stream.read(8192)
            if not chunk:
                break
            remaining = limit - len(buffer)
            if remaining > 0:
                buffer.extend(chunk[:remaining])
            if len(chunk) > remaining and not output_limited.is_set():
                output_limited.set()
                try:
                    process.kill()
                except OSError:
                    pass

    def feed_input():
        try:
            if input_text:
                process.stdin.write(input_text.encode("utf-8"))
                process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    readers = [
        threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True)
    ]
    writer = threading.Thread(target=feed_input, daemon=True)
    for thread in readers:
        thread.start()
    writer.start()

    timed_out = False
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        returncode = process.wait()

    writer.join(timeout=2)
    for thread in readers:
        thread.join(timeout=2)
    for stream in (process.stdin, process.stdout, process.stderr):
        try:
            stream.close()
        except OSError:
            pass

    stdout_text = bytes(buffers["stdout"]).decode("utf-8", errors="replace")
    stderr_text = bytes(buffers["stderr"]).decode("utf-8", errors="replace")

    if output_limited.is_set():
        raise ProcessOutputLimitExceeded(
            "プログラム出力が上限を超えたため停止しました（標準出力1MB / 標準エラー256KB）。"
        )
    if timed_out:
        raise subprocess.TimeoutExpired(
            args, timeout, output=stdout_text, stderr=stderr_text
        )

    return subprocess.CompletedProcess(args, returncode, stdout_text, stderr_text)

try:
    from discord_runtime import DiscordBot, DiscordError
    PS_DISCORD_AVAILABLE = True
except ImportError:
    try:
        # これまでの ps_discord.py というファイル名も利用できる。
        from ps_discord import DiscordBot, DiscordError
        PS_DISCORD_AVAILABLE = True
    except ImportError:
        DiscordBot = None
        DiscordError = Exception
        PS_DISCORD_AVAILABLE = False


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

MAX_CONCURRENT_PS_RUNS = 2
ps_run_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_PS_RUNS)


def limit_ps_run_concurrency(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not ps_run_semaphore.acquire(blocking=False):
            return jsonify({
                "success": False,
                "error": "実行枠が埋まっています。少し待ってから再試行してください。"
            }), 503
        try:
            return view(*args, **kwargs)
        finally:
            ps_run_semaphore.release()
    return wrapped


MAX_PS_SOURCE_BYTES = 512 * 1024
MAX_PS_STDIN_BYTES = 128 * 1024
MAX_DISCORD_CONTENT_CHARS = 2000


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({
        "success": False,
        "error": "リクエスト本文が上限（2MB）を超えています。"
    }), 413


def source_size_bytes(source):
    return len(source.encode("utf-8"))


discord_bot = None
discord_bot_lock = threading.Lock()


def get_discord_bot():
    global discord_bot
    with discord_bot_lock:
        return discord_bot


def set_discord_bot(bot):
    global discord_bot
    with discord_bot_lock:
        discord_bot = bot


@app.route("/")
def index():
    return render_template("index.html")


# ====================================================
# Lexer
# ====================================================

def tokenize(source_code):
    token_specification = [
        ("COMMENT", r"#.*"),
        ("STRING", r'"[^"\\]*(?:\\.[^"\\]*)*"'),
        ("NUMBER", r"\d+(?:\.\d+)?"),
        ("KEYWORDS", r"\b(if|elif|else|while|for|in|break|continue|func|return)\b"),
        ("LOGIC", r"\b(and|or|not)\b"),
        ("ID", r"[a-zA-Z_]\w*"),
        ("OP", r"\*\*|\+\+|--|\+=|-=|\*=|/=|%=|<<|>>|&=|\|=|\^=|==|!=|<=|>=|[+\-*/%=<>!&|^~.]"),
        ("LPAREN", r"\("),
        ("RPAREN", r"\)"),
        ("LBRACK", r"\["),
        ("RBRACK", r"\]"),
        ("COMMA", r","),
        ("NL", r"\n"),
        ("SKIP", r"[ \t]+"),
        ("MISMATCH", r"."),
    ]

    tok_regex = "|".join(
        f"(?P<{name}>{regex})"
        for name, regex in token_specification
    )

    tokens = []

    for line_num, line in enumerate(source_code.split("\n"), 1):
        if not line.strip() or line.strip().startswith("#"):
            continue

        indent_match = re.match(r"^(\s*)", line)
        indent_len = len(indent_match.group(1)) if indent_match else 0

        if indent_len % 4 != 0:
            raise Exception(
                f"インデントエラー (行 {line_num}): "
                "半角スペース4つ単位で字下げしてください。"
            )

        indent_level = indent_len // 4

        for mo in re.finditer(tok_regex, line):
            kind = mo.lastgroup
            value = mo.group()

            if kind in ("COMMENT", "SKIP"):
                continue

            if kind == "MISMATCH":
                raise Exception(
                    f"構文エラー (行 {line_num}): "
                    f"不正な文字 '{value}' があります。"
                )

            tokens.append({
                "type": kind,
                "value": value,
                "line": line_num,
                "indent": indent_level
            })

        tokens.append({
            "type": "NL",
            "value": "\n",
            "line": line_num,
            "indent": indent_level
        })

    return tokens


# ====================================================
# Expression Parser
# ====================================================

class ExpressionParser:
    """Recursive-descent expression parser with explicit precedence."""

    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def peek(self):
        if self.pos < len(self.tokens) and self.tokens[self.pos]["type"] != "NL":
            return self.tokens[self.pos]
        return None

    def consume(self, expected_type=None, expected_value=None):
        tok = self.peek()
        if tok is None:
            return None
        if expected_type is not None and tok["type"] != expected_type:
            return None
        if expected_value is not None and tok["value"] != expected_value:
            return None
        self.pos += 1
        return tok

    def expect(self, expected_type=None, expected_value=None):
        tok = self.consume(expected_type, expected_value)
        if tok is None:
            wanted = expected_value or expected_type or "トークン"
            raise Exception(f"構文エラー: {wanted} が必要です。")
        return tok

    def at_end(self):
        return self.peek() is None

    def parse(self):
        node = self.parse_or()
        if not self.at_end():
            tok = self.peek()
            raise Exception(f"構文エラー (行 {tok['line']}): 未対応または不正なトークン '{tok['value']}' があります。")
        return node

    # Lowest -> highest precedence.
    def parse_or(self):
        node = self.parse_and()
        while self.peek() and self.peek()["type"] == "LOGIC" and self.peek()["value"] == "or":
            self.consume()
            node = {"type": "BinaryExpr", "op": "||", "left": node, "right": self.parse_and()}
        return node

    def parse_and(self):
        node = self.parse_bit_or()
        while self.peek() and self.peek()["type"] == "LOGIC" and self.peek()["value"] == "and":
            self.consume()
            node = {"type": "BinaryExpr", "op": "&&", "left": node, "right": self.parse_bit_or()}
        return node

    def parse_bit_or(self):
        node = self.parse_bit_xor()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] == "|":
            self.consume()
            node = {"type": "BinaryExpr", "op": "|", "left": node, "right": self.parse_bit_xor()}
        return node

    def parse_bit_xor(self):
        node = self.parse_bit_and()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] == "^":
            self.consume()
            node = {"type": "BinaryExpr", "op": "^", "left": node, "right": self.parse_bit_and()}
        return node

    def parse_bit_and(self):
        node = self.parse_equality()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] == "&":
            self.consume()
            node = {"type": "BinaryExpr", "op": "&", "left": node, "right": self.parse_equality()}
        return node

    def parse_equality(self):
        node = self.parse_shift()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] in ["==", "!=", "<", ">", "<=", ">="]:
            op = self.consume()["value"]
            node = {"type": "BinaryExpr", "op": op, "left": node, "right": self.parse_shift()}
        return node

    def parse_shift(self):
        node = self.parse_expr()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] in ["<<", ">>"]:
            op = self.consume()["value"]
            node = {"type": "BinaryExpr", "op": op, "left": node, "right": self.parse_expr()}
        return node

    def parse_expr(self):
        node = self.parse_term()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] in ["+", "-"]:
            op = self.consume()["value"]
            node = {"type": "BinaryExpr", "op": op, "left": node, "right": self.parse_term()}
        return node

    def parse_term(self):
        node = self.parse_power()
        while self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] in ["*", "/", "%"]:
            op = self.consume()["value"]
            node = {"type": "BinaryExpr", "op": op, "left": node, "right": self.parse_power()}
        return node

    def parse_power(self):
        node = self.parse_unary()
        # ** is right-associative: a ** b ** c == a ** (b ** c)
        if self.peek() and self.peek()["type"] == "OP" and self.peek()["value"] == "**":
            self.consume()
            node = {"type": "BinaryExpr", "op": "**", "left": node, "right": self.parse_power()}
        return node

    def parse_unary(self):
        tok = self.peek()
        if tok and tok["type"] == "LOGIC" and tok["value"] == "not":
            self.consume()
            return {"type": "UnaryExpr", "op": "!", "right": self.parse_unary()}
        if tok and tok["type"] == "OP" and tok["value"] in ["!", "+", "-", "~", "++", "--"]:
            op = self.consume()["value"]
            return {"type": "UnaryExpr", "op": op, "right": self.parse_unary()}
        return self.parse_postfix()

    def parse_postfix(self):
        node = self.parse_primary()
        while self.peek():
            tok = self.peek()
            if tok["type"] == "OP" and tok["value"] in ["++", "--"]:
                op = self.consume()["value"]
                node = {"type": "PostfixExpr", "op": op, "value": node}
                continue
            if tok["type"] == "OP" and tok["value"] == ".":
                self.consume("OP", ".")
                member = self.expect("ID")
                node = {"type": "MemberExpr", "object": node, "property": member["value"]}
                continue
            break
        return node

    def parse_primary(self):
        tok = self.peek()
        if not tok:
            return None

        if tok["type"] in ("NUMBER", "STRING"):
            return {"type": "Literal", "value": self.consume()["value"]}

        if tok["type"] == "LBRACK":
            self.consume("LBRACK")
            elements = []
            if self.peek() and self.peek()["type"] != "RBRACK":
                while True:
                    elements.append(self.parse_or())
                    if not self.consume("COMMA"):
                        break
            self.expect("RBRACK")
            return {"type": "ArrayLiteral", "elements": elements}

        if tok["type"] == "ID":
            name = self.consume()["value"]
            if self.consume("LPAREN"):
                args = []
                if self.peek() and self.peek()["type"] != "RPAREN":
                    while True:
                        args.append(self.parse_or())
                        if not self.consume("COMMA"):
                            break
                self.expect("RPAREN")
                return {"type": "CallExpr", "name": name, "args": args}
            if self.consume("LBRACK"):
                index_node = self.parse_or()
                self.expect("RBRACK")
                return {"type": "IndexExpr", "name": name, "index": index_node}
            return {"type": "Variable", "value": name}

        if tok["type"] == "LPAREN":
            self.consume("LPAREN")
            node = self.parse_or()
            self.expect("RPAREN")
            return node

        raise Exception(f"構文エラー (行 {tok['line']}): 式として解釈できない '{tok['value']}' があります。")


# ====================================================
# Parser
# ====================================================

def parse(tokens):
    root = {
        "type": "Program",
        "body": []
    }

    if not tokens:
        return root

    stack = [(-1, root)]
    i = 0

    while i < len(tokens):
        token = tokens[i]

        if token["type"] == "NL":
            i += 1
            continue

        while (
            stack
            and token["indent"] <= stack[-1][0]
        ):
            stack.pop()

        parent = stack[-1][1]

        node = {
            "line": token["line"]
        }

        line_tokens = []

        while (
            i < len(tokens)
            and tokens[i]["type"] != "NL"
        ):
            line_tokens.append(tokens[i])
            i += 1

        if i < len(tokens):
            i += 1

        if not line_tokens:
            continue

        first = line_tokens[0]

        # ECS declarations are contextual identifiers, not lexer keywords.
        # This preserves backwards compatibility for variables named "component" or "system".
        if (first["type"] == "ID" and first["value"] in ("component", "system")
                and len(line_tokens) >= 2 and line_tokens[1]["type"] == "ID"):
            if parent is not root:
                raise Exception(f"構文エラー (行 {first['line']}): ECS宣言はファイルのトップレベルに置いてください。")
            if len(line_tokens) < 2 or line_tokens[1]["type"] != "ID":
                raise Exception(f"構文エラー (行 {first['line']}): {first['value']} の後ろに名前が必要です。")
            declaration_name = line_tokens[1]["value"]
            if first["value"] == "component":
                if len(line_tokens) != 2:
                    raise Exception(f"構文エラー (行 {first['line']}): component Name の形式で宣言してください。")
                node.update({"type": "ComponentDef", "name": declaration_name, "body": []})
            else:
                rest = line_tokens[2:]
                if len(rest) < 2 or rest[0]["type"] != "LPAREN" or rest[-1]["type"] != "RPAREN":
                    raise Exception(f"構文エラー (行 {first['line']}): system Name(ComponentA, ComponentB) の形式で宣言してください。")
                inner = rest[1:-1]
                component_names = []
                expect_id = True
                for tok in inner:
                    if expect_id:
                        if tok["type"] != "ID":
                            raise Exception(f"構文エラー (行 {tok['line']}): Systemのコンポーネント名が必要です。")
                        component_names.append(tok["value"])
                    else:
                        if tok["type"] != "COMMA":
                            raise Exception(f"構文エラー (行 {tok['line']}): コンポーネント名はカンマで区切ってください。")
                    expect_id = not expect_id
                if inner and expect_id:
                    raise Exception(f"構文エラー (行 {first['line']}): コンポーネント名の後ろが不正です。")
                if len(component_names) != len(set(component_names)):
                    raise Exception(f"構文エラー (行 {first['line']}): System内のコンポーネント名が重複しています。")
                if not component_names:
                    raise Exception(f"構文エラー (行 {first['line']}): Systemには1つ以上のコンポーネントが必要です。")
                node.update({"type": "SystemDef", "name": declaration_name, "components": component_names, "body": []})
            parent["body"].append(node)
            stack.append((first["indent"], node))
            continue

        if (
            first["type"] == "KEYWORDS"
            and first["value"] == "func"
        ):
            if (
                len(line_tokens) < 2
                or line_tokens[1]["type"] != "ID"
            ):
                raise Exception(
                    f"構文エラー (行 {first['line']}): "
                    "func の後ろに関数名が必要です。"
                )

            func_name = line_tokens[1]["value"]
            params = []
            rest = line_tokens[2:]
            if rest:
                if rest[0]["type"] != "LPAREN" or rest[-1]["type"] != "RPAREN":
                    raise Exception(
                        f"構文エラー (行 {first['line']}): "
                        "func は func name(a, b) の形式で定義してください。"
                    )
                inner = rest[1:-1]
                expect_id = True
                for tok in inner:
                    if expect_id:
                        if tok["type"] != "ID":
                            raise Exception(
                                f"構文エラー (行 {tok['line']}): 関数パラメータ名が必要です。"
                            )
                        params.append(tok["value"])
                    else:
                        if tok["type"] != "COMMA":
                            raise Exception(
                                f"構文エラー (行 {tok['line']}): パラメータはカンマで区切ってください。"
                            )
                    expect_id = not expect_id
                if inner and expect_id:
                    raise Exception(
                        f"構文エラー (行 {first['line']}): 関数パラメータの後ろが不正です。"
                    )
                if len(params) != len(set(params)):
                    raise Exception(
                        f"構文エラー (行 {first['line']}): パラメータ名が重複しています。"
                    )

            node.update({
                "type": "FunctionDef",
                "name": func_name,
                "params": params,
                "body": []
            })

            parent["body"].append(node)
            stack.append((first["indent"], node))
            continue

        if (
            first["type"] == "KEYWORDS"
            and first["value"] in ["if", "elif", "while"]
        ):
            if first["value"] == "if":
                kind = "IfStatement"
            elif first["value"] == "elif":
                kind = "ElifStatement"
            else:
                kind = "WhileStatement"

            expr_parser = ExpressionParser(line_tokens[1:])
            cond_ast = expr_parser.parse()

            node.update({
                "type": kind,
                "condition": cond_ast,
                "body": []
            })

            parent["body"].append(node)
            stack.append((first["indent"], node))
            continue

        if (
            first["type"] == "KEYWORDS"
            and first["value"] == "else"
        ):
            node.update({
                "type": "ElseStatement",
                "body": []
            })

            parent["body"].append(node)
            stack.append((first["indent"], node))
            continue

        if (
            first["type"] == "KEYWORDS"
            and first["value"] == "for"
        ):
            if (
                len(line_tokens) < 4
                or line_tokens[1]["type"] != "ID"
                or line_tokens[2]["value"] != "in"
            ):
                raise Exception(
                    f"構文エラー (行 {first['line']}): "
                    "for 変数 in 範囲 の形式で書いてください。"
                )

            loop_var = line_tokens[1]["value"]

            expr_parser = ExpressionParser(
                line_tokens[3:]
            )

            range_ast = expr_parser.parse()

            node.update({
                "type": "ForStatement",
                "variable": loop_var,
                "range": range_ast,
                "body": []
            })

            parent["body"].append(node)
            stack.append((first["indent"], node))
            continue

        if (
            first["type"] == "KEYWORDS"
            and first["value"] in [
                "break",
                "continue",
                "return"
            ]
        ):
            val = first["value"]

            if val == "return":
                if len(line_tokens) > 1:
                    expr_parser = ExpressionParser(
                        line_tokens[1:]
                    )

                    node.update({
                        "type": "ReturnStatement",
                        "value": expr_parser.parse()
                    })
                else:
                    node.update({
                        "type": "ReturnStatement",
                        "value": None
                    })
            else:
                node.update({
                    "type": val.upper() + "Statement"
                })

            parent["body"].append(node)
            continue

        if (
            first["type"] == "ID"
            and first["value"] == "ps"
        ):
            expr_parser = ExpressionParser(
                line_tokens[1:]
            )

            node.update({
                "type": "PrintStatement",
                "value": expr_parser.parse()
            })

            parent["body"].append(node)
            continue

        if first["type"] == "ID":
            # Property assignment is shared by ECS system fields and ordinary objects.
            assignment_ops = ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]
            nesting = 0
            assignment_index = None
            for token_index, token in enumerate(line_tokens):
                if token["type"] in ("LPAREN", "LBRACK"):
                    nesting += 1
                elif token["type"] in ("RPAREN", "RBRACK"):
                    nesting = max(0, nesting - 1)
                elif nesting == 0 and token["type"] == "OP" and token["value"] in assignment_ops:
                    assignment_index = token_index
                    break
            if assignment_index is not None and assignment_index > 1:
                target_ast = ExpressionParser(line_tokens[:assignment_index]).parse()
                if target_ast.get("type") == "MemberExpr":
                    value_ast = ExpressionParser(line_tokens[assignment_index + 1:]).parse()
                    operator = line_tokens[assignment_index]["value"]
                    node.update({
                        "type": "MemberAssignment" if operator == "=" else "MemberCompoundAssignment",
                        "target": target_ast,
                        "op": operator,
                        "value": value_ast
                    })
                    parent["body"].append(node)
                    continue

            if (
                len(line_tokens) >= 2
                and line_tokens[1]["type"] == "OP"
                and line_tokens[1]["value"] in ["++", "--"]
                and len(line_tokens) == 2
            ):
                parent["body"].append({
                    "type": "ExpressionStatement",
                    "value": {
                        "type": "PostfixExpr",
                        "op": line_tokens[1]["value"],
                        "value": {"type": "Variable", "value": first["value"]}
                    },
                    "line": first["line"]
                })
                continue

            if (
                len(line_tokens) > 1
                and line_tokens[1]["type"] == "LBRACK"
            ):
                idx_end = 1

                while (
                    idx_end < len(line_tokens)
                    and line_tokens[idx_end]["type"]
                    != "RBRACK"
                ):
                    idx_end += 1

                if (
                    idx_end + 1 < len(line_tokens)
                    and line_tokens[idx_end + 1]["value"] in ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]
                ):
                    expr_parser = ExpressionParser(
                        line_tokens[2:idx_end]
                    )

                    idx_ast = expr_parser.parse()

                    expr_parser2 = ExpressionParser(
                        line_tokens[idx_end + 2:]
                    )

                    val_ast = expr_parser2.parse()

                    node.update({
                        "type": "ArrayAssignStatement" if line_tokens[idx_end + 1]["value"] == "=" else "ArrayCompoundAssignStatement",
                        "name": first["value"],
                        "index": idx_ast,
                        "op": line_tokens[idx_end + 1]["value"],
                        "value": val_ast
                    })

                    parent["body"].append(node)
                    continue

            if (
                len(line_tokens) > 1
                and line_tokens[1]["type"] == "OP"
                and line_tokens[1]["value"] in ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]
            ):
                expr_parser = ExpressionParser(
                    line_tokens[2:]
                )

                op = line_tokens[1]["value"]
                node.update({
                    "type": "AssignmentExpression" if op == "=" else "CompoundAssignment",
                    "variable": first["value"],
                    "op": op,
                    "value": expr_parser.parse()
                })

                parent["body"].append(node)
            else:
                expr_parser = ExpressionParser(
                    line_tokens
                )

                node.update({
                    "type": "ExpressionStatement",
                    "value": expr_parser.parse()
                })

                parent["body"].append(node)

    return root


# ====================================================
# Semantic validation
# ====================================================

BUILTIN_FUNCTIONS = {
    "len": 1,
    "range": (1, 3),
    "input": (0, 1),
} | {name: None for name in DISCORD_FUNCTIONS} if "DISCORD_FUNCTIONS" in globals() else {
    "len": 1,
    "range": (1, 3),
    "input": (0, 1),
}

COMPOUND_OPERATORS = {"+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="}


def _literal_kind(node):
    if not node or node.get("type") != "Literal":
        return None
    raw = node.get("value", "")
    if raw in ("true", "false"):
        return "bool"
    if raw.startswith('"'):
        return "string"
    if "." in raw:
        return "float"
    return "int"


GAME_FUNCTIONS = {
    "get_x": 0, "get_y": 0, "get_z": 0, "set_x": 1, "set_y": 1, "set_z": 1,
    "rotate_x": 1, "rotate_y": 1, "rotate_z": 1,
    "is_key_down": 1, "is_touched": 0, "get_touch_x": 0, "get_touch_y": 0,
    "draw_sprite": 3, "draw_rect": 4, "draw_circle": 3,
    "draw_cube": 4, "draw_box": 6, "draw_sphere": 4,
    "draw_plane": 5, "draw_cylinder": 5, "draw_cone": 5, "draw_capsule": 5,
    "add_triangle_collider": 9,
    "draw_grid": 2, "set_camera": 6, "set_camera_follow": 7,
    "camera_shake": 2, "set_time_scale": 1, "draw_trail": 4, "set_god_rays": 2,
    "set_background": 1, "set_fog": 3, "set_light": 4, "set_material": 2,
    "set_point_light": 6, "set_spot_light": 9, "set_environment": 3, "set_shader": 1,
    "set_toon_material": 14,
    "draw_terrain": 7, "draw_water": 7, "emit_particles": 7,
    "set_model_material": 4, "set_postprocessing": 3,
    "particle_emitter": 6, "stop_particle_emitter": 1, "solve_ik": 7, "animation_layer": 3,
    "weapon_define": 4, "weapon_attack": 4, "combo_count": 0, "enemy_ai": 4, "ai_state": 0,
    "define_item": 4, "equip_item": 1, "use_item": 1, "open_inventory": 0, "open_quest_log": 0, "close_game_ui": 0,
    "show_dialogue": 5, "dialogue_choice": 0, "quest_define": 4, "nav_build_from_triangles": 2,
    "set_point_light": 6, "set_spot_light": 9, "set_environment": 3,
    "draw_terrain": 7, "draw_water": 7,
    "physics_body": 6, "set_gravity": 3, "apply_force": 3, "apply_impulse": 3,
    "get_velocity_x": 0, "get_velocity_y": 0, "get_velocity_z": 0,
    "set_velocity_x": 1, "set_velocity_y": 1, "set_velocity_z": 1,
    "character_controller": 3, "move_character": 2, "jump": 1, "is_grounded": 0, "character_animation": 6,
    "set_max_hp": 1, "set_hp": 1, "get_hp": 0, "get_max_hp": 0, "damage": 1, "heal": 1, "is_alive": 0,
    "apply_damage": 2, "attack_hitbox": 2, "use_skill": 3, "enemy_follow": 3, "enemy_attack": 4,
    "inventory_add": 2, "inventory_remove": 2, "inventory_count": 1,
    "quest_start": 1, "quest_complete": 1, "quest_is_complete": 1, "quest_set_progress": 3, "quest_get_progress": 1,
    "nav_add_node": 4, "nav_connect": 2, "nav_build_grid": 5, "nav_build_from_triangles": 2, "nav_build_from_terrain": 8, "nav_build_from_model": 6, "nav_block_node": 2, "nav_next_node": 2, "nav_clear": 0,
    "draw_hud_text": 5, "draw_hud_bar": 7,
    "play_sound": 3, "stop_sound": 1, "set_sound_volume": 2,
    "set_step_height": 1, "set_max_slope": 1,
    "get_axis": 1, "was_key_pressed": 1,
    "load_model": 5, "play_animation": 1, "play_animation_once": 1, "blend_animations": 3, "stop_animation": 0, "set_animation_speed": 1,
    "get_delta_time": 0, "get_width": 0, "get_height": 0,
}
GAME_LIFECYCLE = {"start": 0, "update": 1, "on_collision": 1}

# Names accepted by the ps lexer must also be valid identifiers in generated C++17.
CPP_RESERVED_IDENTIFIERS = set("""
alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto
bitand bitor bool break case catch char char8_t char16_t char32_t class compl
concept const consteval constexpr constinit const_cast continue co_await co_return
co_yield decltype default delete do double dynamic_cast else enum explicit export
extern false float for friend goto if inline int long mutable namespace new noexcept
not not_eq nullptr operator or or_eq private protected public register reinterpret_cast
requires return short signed sizeof static static_assert static_cast struct switch
synchronized template this thread_local throw true try typedef typeid typename union
unsigned using virtual void volatile wchar_t while xor xor_eq
""".split())


def _validate_cpp_identifier(name, line=None):
    if name in CPP_RESERVED_IDENTIFIERS or name in ("true", "false"):
        raise Exception(
            f"意味エラー (行 {line or '?'}): '{name}' はC++予約語またはpsの論理値なので、識別子として使用できません。"
        )
    if name.startswith("__") or (len(name) > 1 and name[0] == "_" and name[1].isupper()):
        raise Exception(
            f"意味エラー (行 {line or '?'}): '{name}' は予約された識別子形式です。別の名前を使用してください。"
        )


def _ecs_binding_name(component_name):
    """Convert ComponentName to the stable lower_snake_case binding used in system bodies."""
    separated = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", component_name)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", separated).lower()


def validate_ast(tree, allow_game=False, external_components=None):
    """Validate ps semantics. ECS declarations are currently browser-game-only."""
    functions = {}
    component_defs = {}
    system_defs = {}
    for node in tree.get("body", []):
        if node.get("type") == "ComponentDef":
            name = node.get("name", "")
            _validate_cpp_identifier(name, node.get("line"))
            if name in ("Transform", "SceneObjectRef", "Velocity", "PhysicsBody", "PhysicsState", "PhysicsTransform", "Health", "Inventory", "Equipment", "CombatState", "AIController", "MovementIntent", "QuestProgress", "DialogueSession", "NavigationNode", "InputSnapshot", "PlayerInput", "ControlIntent", "CollisionEvent", "AudioEmitter", "AudioCommand", "Renderable", "Camera", "Light", "Animation", "WorldPartition", "StreamingInterest"):
                raise Exception(f"意味エラー: '{name}' はPStudio組み込みComponentのため再定義できません。")
            if name in component_defs:
                raise Exception(f"意味エラー: Component '{name}' が重複定義されています。")
            fields = {}
            for field in node.get("body", []):
                if field.get("type") != "AssignmentExpression":
                    raise Exception(f"意味エラー (行 {field.get('line', '?')}): Component定義内では 'field = 初期値' 形式のみ使用できます。")
                field_name = field.get("variable", "")
                _validate_cpp_identifier(field_name, field.get("line"))
                if field_name in fields:
                    raise Exception(f"意味エラー: Component '{name}' のField '{field_name}' が重複しています。")
                value = field.get("value", {})
                def is_literal_default(value_node):
                    if value_node.get("type") == "Literal":
                        return True
                    if value_node.get("type") == "ArrayLiteral":
                        return all(is_literal_default(element) for element in value_node.get("elements", []))
                    return False
                if not is_literal_default(value):
                    raise Exception(f"意味エラー: Component '{name}.{field_name}' の初期値はリテラルまたはリテラル配列にしてください。")
                fields[field_name] = value
            component_defs[name] = fields
        elif node.get("type") == "SystemDef":
            name = node.get("name", "")
            _validate_cpp_identifier(name, node.get("line"))
            if name in system_defs:
                raise Exception(f"意味エラー: System '{name}' が重複定義されています。")
            system_defs[name] = node
        elif node.get("type") == "FunctionDef":
            name = node["name"]
        if node.get("type") == "FunctionDef":
            name = node["name"]
            _validate_cpp_identifier(name, node.get("line"))
            if name in functions:
                raise Exception(f"意味エラー (行 {node.get('line', '?')}): 関数 '{name}' が重複定義されています。")
            for param in node.get("params", []):
                _validate_cpp_identifier(param, node.get("line"))
            functions[name] = len(node.get("params", []))

    if (component_defs or system_defs) and not allow_game:
        raise Exception("意味エラー: component/system宣言はブラウザゲームスクリプト内でのみ使用できます。")

    builtin_component_fields = {
        "Transform": {
            "x": {"type": "Literal", "value": "0.0"},
            "y": {"type": "Literal", "value": "0.0"},
            "z": {"type": "Literal", "value": "0.0"},
            "rotationX": {"type": "Literal", "value": "0.0"},
            "rotationY": {"type": "Literal", "value": "0.0"},
            "rotationZ": {"type": "Literal", "value": "0.0"},
            "scaleX": {"type": "Literal", "value": "1.0"},
            "scaleY": {"type": "Literal", "value": "1.0"},
            "scaleZ": {"type": "Literal", "value": "1.0"},
        },
        "SceneObjectRef": {"sceneObjectId": {"type": "Literal", "value": '""'}},
        "Velocity": {
            "x": {"type": "Literal", "value": "0.0"},
            "y": {"type": "Literal", "value": "0.0"},
            "z": {"type": "Literal", "value": "0.0"},
        },
        "PhysicsTransform": {
            "x": {"type": "Literal", "value": "0.0"},
            "y": {"type": "Literal", "value": "0.0"},
            "z": {"type": "Literal", "value": "0.0"},
        },
        "PhysicsState": {
            "x": {"type": "Literal", "value": "0.0"},
            "y": {"type": "Literal", "value": "0.0"},
            "z": {"type": "Literal", "value": "0.0"},
            "velocityX": {"type": "Literal", "value": "0.0"},
            "velocityY": {"type": "Literal", "value": "0.0"},
            "velocityZ": {"type": "Literal", "value": "0.0"},
            "horizontalSpeed": {"type": "Literal", "value": "0.0"},
            "grounded": {"type": "Literal", "value": "false"},
            "controlled": {"type": "Literal", "value": "false"},
            "jumped": {"type": "Literal", "value": "false"},
            "landed": {"type": "Literal", "value": "false"},
            "airTime": {"type": "Literal", "value": "0.0"},
            "active": {"type": "Literal", "value": "true"},
        },
        "PhysicsBody": {
            "enabled": {"type": "Literal", "value": "true"},
            "positionX": {"type": "Literal", "value": "0.0"},
            "positionY": {"type": "Literal", "value": "0.0"},
            "positionZ": {"type": "Literal", "value": "0.0"},
            "radius": {"type": "Literal", "value": "0.35"},
            "height": {"type": "Literal", "value": "1.8"},
            "mass": {"type": "Literal", "value": "1.0"},
            "gravityX": {"type": "Literal", "value": "0.0"},
            "gravityY": {"type": "Literal", "value": "-9.81"},
            "gravityZ": {"type": "Literal", "value": "0.0"},
            "controllerEnabled": {"type": "Literal", "value": "false"},
            "maxSpeed": {"type": "Literal", "value": "5.0"},
            "acceleration": {"type": "Literal", "value": "24.0"},
            "airControl": {"type": "Literal", "value": "0.25"},
            "stepHeight": {"type": "Literal", "value": "0.35"},
            "maxSlope": {"type": "Literal", "value": "50.0"},
        },
    }
    external_components = external_components or {}
    component_fields = {**builtin_component_fields, **external_components, **component_defs}
    binding_names = {}
    for component_name in component_fields:
        binding = _ecs_binding_name(component_name)
        if binding in binding_names and binding_names[binding] != component_name:
            raise Exception(f"意味エラー: Component binding '{binding}' が重複しています。")
        binding_names[binding] = component_name
    for system in system_defs.values():
        for component_name in system.get("components", []):
            if component_name not in component_fields:
                raise Exception(f"意味エラー: System '{system['name']}' が未定義Component '{component_name}' を要求しています。")

    game_functions = GAME_FUNCTIONS if allow_game else {}
    if allow_game:
        # Browser game scripts deliberately exclude stdin and Discord/network side effects.
        known_calls = (set(BUILTIN_FUNCTIONS) - {"input"}) | set(functions) | set(game_functions)
    else:
        known_calls = set(BUILTIN_FUNCTIONS) | set(functions) | set(DISCORD_FUNCTIONS)
    declared = {}

    # Game callbacks may refer to script-level state declared elsewhere in the file.
    # Predeclare those names only for the game runtime; ordinary ps validation stays strict.
    game_globals = {}
    if allow_game:
        def collect_globals(nodes):
            for item in nodes:
                kind = item.get("type")
                if kind == "AssignmentExpression":
                    game_globals.setdefault(item["variable"], None)
                elif kind == "CompoundAssignment":
                    game_globals.setdefault(item["variable"], None)
                elif kind in ("FunctionDef", "ComponentDef", "SystemDef"):
                    continue
                elif isinstance(item.get("body"), list):
                    collect_globals(item["body"])
        collect_globals(tree.get("body", []))

    def expr(node, env):
        if node is None:
            raise Exception("意味エラー: 式がありません。")
        typ = node.get("type")
        if typ == "Literal":
            return _literal_kind(node)
        if typ == "Variable":
            name = node["value"]
            if name not in env and name not in ("true", "false"):
                raise Exception(f"意味エラー: 未定義の変数 '{name}' です。")
            return env.get(name)
        if typ == "ArrayLiteral":
            kinds = [expr(x, env) for x in node.get("elements", [])]
            kinds = [k for k in kinds if k is not None]
            if not kinds:
                return "array<int>"
            first = kinds[0]
            if any(k != first for k in kinds):
                raise Exception("意味エラー: 配列の要素型を統一してください。")
            return f"array<{first}>"
        if typ == "IndexExpr":
            base = expr({"type": "Variable", "value": node["name"]}, env)
            idx = expr(node["index"], env)
            if idx not in ("int", "float") and idx is not None:
                raise Exception("意味エラー: 配列のインデックスは数値で指定してください。")
            if not isinstance(base, str) or not base.startswith("array<"):
                raise Exception(f"意味エラー: '{node['name']}' は配列ではありません。")
            return base[6:-1]
        if typ == "MemberExpr":
            owner = node.get("object", {})
            if owner.get("type") != "Variable":
                raise Exception("意味エラー: Componentメンバーは 'component.field' 形式で参照してください。")
            owner_type = env.get(owner.get("value"))
            if not isinstance(owner_type, str) or not owner_type.startswith("component:"):
                raise Exception(f"意味エラー: '{owner.get('value')}' はComponent bindingではありません。")
            component_name = owner_type.split(":", 1)[1]
            field_name = node.get("property", "")
            if field_name not in component_fields.get(component_name, {}):
                raise Exception(f"意味エラー: Component '{component_name}' にField '{field_name}' はありません。")
            return _literal_kind(component_fields[component_name][field_name])
        if typ == "UnaryExpr":
            op = node["op"]
            value_type = expr(node["right"], env)
            if op in ("+", "-") and value_type not in ("int", "float", None):
                raise Exception(f"意味エラー: 単項演算子 '{op}' は数値に使用してください。")
            if op == "~" and value_type not in ("int", None):
                raise Exception("意味エラー: '~' は整数に使用してください。")
            if op in ("++", "--"):
                if node["right"].get("type") not in ("Variable", "IndexExpr"):
                    raise Exception(f"意味エラー: '{op}' の対象は変数または配列要素である必要があります。")
            return "bool" if op == "!" else value_type
        if typ == "PostfixExpr":
            value_type = expr(node["value"], env)
            if node["value"].get("type") not in ("Variable", "IndexExpr"):
                raise Exception(f"意味エラー: '{node['op']}' の対象は変数または配列要素である必要があります。")
            if value_type not in ("int", "float"):
                raise Exception(f"意味エラー: '{node['op']}' は数値に使用してください。")
            return value_type
        if typ == "BinaryExpr":
            op = node["op"]
            left = expr(node["left"], env)
            right = expr(node["right"], env)
            if op in ("&&", "||"):
                return "bool"
            if op in ("&", "|", "^", "<<", ">>"):
                if (left not in ("int", None)) or (right not in ("int", None)):
                    raise Exception(f"意味エラー: '{op}' は整数に使用してください。")
                return "int"
            if op == "**":
                if left not in ("int", "float", None) or right not in ("int", "float", None):
                    raise Exception("意味エラー: '**' は数値に使用してください。")
                return "float"
            if op in ("+", "-", "*", "/", "%"):
                if left == "string" and right == "string" and op == "+":
                    return "string"
                if left not in ("int", "float", None) or right not in ("int", "float", None):
                    raise Exception(f"意味エラー: '{op}' のオペランド型が不正です。")
                return "float" if "float" in (left, right) or op == "/" else "int"
            if op in ("==", "!=", "<", ">", "<=", ">="):
                return "bool"
            return None
        if typ == "CallExpr":
            name = node["name"]
            args = node.get("args", [])
            for arg in args:
                expr(arg, env)
            if name not in known_calls:
                raise Exception(f"意味エラー: 未定義の関数 '{name}' です。")
            arity = functions.get(name, BUILTIN_FUNCTIONS.get(name, game_functions.get(name)))
            if isinstance(arity, int) and len(args) != arity:
                raise Exception(f"意味エラー: {name}() は引数を {arity} 個指定してください。")
            if isinstance(arity, tuple) and not (arity[0] <= len(args) <= arity[1]):
                raise Exception(f"意味エラー: {name}() の引数は {arity[0]}〜{arity[1]} 個です。")
            if name == "input":
                return "string"
            if name == "len":
                return "int"
            if name == "range":
                return "array<int>"
            return None
        raise Exception(f"意味エラー: 未対応の式 '{typ}' です。")

    def block(nodes, env, loop_depth=0, function_depth=0):
        previous = None
        for index, node in enumerate(nodes):
            typ = node.get("type")
            if typ == "IfStatement":
                expr(node.get("condition"), env)
                block(node.get("body", []), env, loop_depth, function_depth)
                j = index + 1
                while j < len(nodes) and nodes[j].get("type") in ("ElifStatement", "ElseStatement"):
                    branch = nodes[j]
                    if branch.get("type") == "ElifStatement":
                        expr(branch.get("condition"), env)
                    block(branch.get("body", []), env, loop_depth, function_depth)
                    j += 1
                previous = typ
                continue
            if typ == "ElifStatement":
                if previous not in ("IfStatement", "ElifStatement"):
                    raise Exception(f"意味エラー (行 {node.get('line', '?')}): elif は if/elif の直後に置いてください。")
                previous = typ
                continue
            if typ == "ElseStatement":
                if previous not in ("IfStatement", "ElifStatement"):
                    raise Exception(f"意味エラー (行 {node.get('line', '?')}): else は if/elif の直後に置いてください。")
                previous = typ
                continue
            if typ in ("BREAKStatement", "CONTINUEStatement") and loop_depth <= 0:
                raise Exception(f"意味エラー (行 {node.get('line', '?')}): {typ.replace('Statement', '').lower()} はループ内でのみ使用できます。")
            if typ in ("ComponentDef", "SystemDef"):
                previous = typ
                continue
            if typ == "FunctionDef":
                function_env = dict(game_globals) if allow_game else {}
                function_env.update({p: None for p in node.get("params", [])})
                block(node.get("body", []), function_env, loop_depth=0, function_depth=function_depth + 1)
                previous = typ
                continue
            if typ in ("MemberAssignment", "MemberCompoundAssignment"):
                target = node.get("target", {})
                if target.get("type") != "MemberExpr":
                    raise Exception(f"意味エラー (行 {node.get('line', '?')}): Member代入先が不正です。")
                target_type = expr(target, env)
                value_type = expr(node.get("value"), env)
                if node.get("type") == "MemberAssignment" and target_type is not None and value_type is not None:
                    compatible = target_type == value_type or (target_type == "float" and value_type == "int")
                    if not compatible:
                        raise Exception(f"意味エラー: Component Fieldへの代入型が一致しません ({target_type} <- {value_type})。")
                if node.get("type") == "MemberCompoundAssignment":
                    if node.get("op") not in COMPOUND_OPERATORS:
                        raise Exception("意味エラー: 未対応のMember複合代入演算子です。")
                    if target_type not in ("int", "float", None) or value_type not in ("int", "float", None):
                        raise Exception("意味エラー: Member複合代入は数値Fieldに使用してください。")
            elif typ == "AssignmentExpression":
                _validate_cpp_identifier(node["variable"], node.get("line"))
                env[node["variable"]] = expr(node["value"], env)
            elif typ == "CompoundAssignment":
                name = node["variable"]
                _validate_cpp_identifier(name, node.get("line"))
                if name not in env:
                    raise Exception(f"意味エラー (行 {node.get('line', '?')}): 未定義の変数 '{name}' に複合代入しています。")
                expr(node["value"], env)
            elif typ in ("ArrayAssignStatement", "ArrayCompoundAssignStatement"):
                _validate_cpp_identifier(node["name"], node.get("line"))
                base = env.get(node["name"])
                if not (isinstance(base, str) and base.startswith("array<")):
                    raise Exception(f"意味エラー: '{node['name']}' は配列ではありません。")
                expr(node["index"], env)
                expr(node["value"], env)
            elif typ == "PrintStatement" or typ == "ExpressionStatement":
                expr(node.get("value"), env)
            elif typ in ("WhileStatement", "ForStatement"):
                if typ == "WhileStatement":
                    expr(node["condition"], env)
                else:
                    expr(node["range"], env)
                    _validate_cpp_identifier(node["variable"], node.get("line"))
                    env[node["variable"]] = "int"
                block(node.get("body", []), env, loop_depth + 1, function_depth)
            elif typ == "ReturnStatement":
                if function_depth <= 0:
                    raise Exception(f"意味エラー (行 {node.get('line', '?')}): return は関数内で使用してください。")
                if node.get("value") is not None:
                    expr(node["value"], env)
            previous = typ

    block(tree.get("body", []), declared)

    if allow_game:
        for system in system_defs.values():
            system_env = {"entity": "int", "dt": "float"}
            for component_name in system.get("components", []):
                system_env[_ecs_binding_name(component_name)] = "component:" + component_name
            block(system.get("body", []), system_env, loop_depth=0, function_depth=1)

    if allow_game:
        for name, expected in GAME_LIFECYCLE.items():
            if name in functions and functions[name] != expected:
                raise Exception(
                    f"ゲーム関数 {name}() の引数は {expected} 個にしてください。"
                )


# ====================================================
# C++ Generator
# ====================================================

def generate_cpp(ast):
    cpp_lines = [
        "#include <iostream>",
        "#include <string>",
        "#include <vector>",
        "#include <algorithm>",
        "#include <type_traits>",
        "#include <cmath>",
        "#include <optional>",
        "#include <stdexcept>",
        "#include <utility>",
        "#include <iterator>",
        "using namespace std;",
        "",
        "template<typename T> bool ps_truthy(const T& v) { return static_cast<bool>(v); }",
        "bool ps_truthy(const string& v) { return !v.empty(); }",
        "template<typename T> bool ps_truthy(const vector<T>& v) { return !v.empty(); }",
        "template<typename A, typename B> auto ps_pow(A a, B b) { return std::pow(a, b); }",
        "template<typename A, typename B> double ps_div(A a, B b) { if (b == 0) throw std::runtime_error(\"division by zero\"); return static_cast<double>(a) / static_cast<double>(b); }",
        "template<typename A, typename B> auto ps_mod(A a, B b) { if constexpr (std::is_floating_point_v<A> || std::is_floating_point_v<B>) { if (b == 0) throw std::runtime_error(\"modulo by zero\"); return std::fmod(static_cast<double>(a), static_cast<double>(b)); } else { if (b == 0) throw std::runtime_error(\"modulo by zero\"); return a % b; } }",
        "template<typename T> T& ps_get(std::optional<T>& slot, const char* name) { if (!slot.has_value()) throw std::runtime_error(std::string(\"未定義の変数: \") + name); return *slot; }",
        "template<typename T, typename U> void ps_set(std::optional<T>& slot, U&& value, const char* name) { (void)name; slot = std::forward<U>(value); }",
        "",
        "template<typename T> int len(const vector<T>& v) { return static_cast<int>(v.size()); }",
        "int len(const string& s) { return static_cast<int>(s.length()); }",
        "string input() { string s; getline(cin, s); return s; }",
        "vector<int> range(int stop) { vector<int> r; for (int i = 0; i < stop; ++i) r.push_back(i); return r; }",
        "vector<int> range(int start, int stop) { vector<int> r; for (int i = start; i < stop; ++i) r.push_back(i); return r; }",
        "vector<int> range(int start, int stop, int step) { vector<int> r; if (step == 0) return r; if (step > 0) for (int i = start; i < stop; i += step) r.push_back(i); else for (int i = start; i > stop; i += step) r.push_back(i); return r; }",
        ""
    ]

    functions_buf = []

    def array_type(node):
        elements = node.get("elements", [])
        if not elements:
            return "vector<int>"
        first = elements[0]
        if first.get("type") == "Literal":
            raw = first.get("value", "")
            if raw.startswith('"'):
                return "vector<string>"
            if raw in ("true", "false"):
                return "vector<bool>"
            if "." in raw:
                return "vector<double>"
        return "vector<int>"

    def to_cpp_expr(node, scoped_vars=None, parameter_names=None):
        if not node:
            return ""
        scoped_vars = scoped_vars or set()
        parameter_names = parameter_names or set()
        typ = node["type"]

        if typ == "Literal":
            return node["value"]
        if typ == "Variable":
            name = node["value"]
            if name in ("true", "false"):
                return name
            if name in scoped_vars:
                return f'ps_get({name}, "{name}")'
            return name
        if typ == "UnaryExpr":
            op = node["op"]
            right = to_cpp_expr(node["right"], scoped_vars, parameter_names)
            if op == "!":
                return f"(!ps_truthy({right}))"
            return f"({op}{right})"
        if typ == "PostfixExpr":
            return f"({to_cpp_expr(node['value'], scoped_vars, parameter_names)}{node['op']})"
        if typ == "BinaryExpr":
            op = node["op"]
            left_node, right_node = node["left"], node["right"]
            left_str = to_cpp_expr(left_node, scoped_vars, parameter_names)
            right_str = to_cpp_expr(right_node, scoped_vars, parameter_names)
            if op == "+" and (
                (left_node.get("type") == "Literal" and left_node.get("value", "").startswith('"'))
                or (right_node.get("type") == "Literal" and right_node.get("value", "").startswith('"'))
            ):
                if left_node.get("type") == "Literal" and left_node.get("value", "").startswith('"'):
                    left_str = f"string({left_str})"
                if right_node.get("type") == "Literal" and right_node.get("value", "").startswith('"'):
                    right_str = f"string({right_str})"
            if op == "**":
                return f"ps_pow({left_str}, {right_str})"
            if op == "/":
                return f"ps_div({left_str}, {right_str})"
            if op == "%":
                return f"ps_mod({left_str}, {right_str})"
            if op in ("&&", "||"):
                return f"(ps_truthy({left_str}) {op} ps_truthy({right_str}))"
            return f"({left_str} {op} {right_str})"
        if typ == "ArrayLiteral":
            cpp_type = array_type(node)
            values = ", ".join(to_cpp_expr(item, scoped_vars, parameter_names) for item in node.get("elements", []))
            return f"{cpp_type}{{{values}}}"
        if typ == "IndexExpr":
            base = to_cpp_expr({"type": "Variable", "value": node["name"]}, scoped_vars, parameter_names)
            return f"{base}[{to_cpp_expr(node['index'], scoped_vars, parameter_names)}]"
        if typ == "CallExpr":
            return node["name"] + "(" + ", ".join(
                to_cpp_expr(arg, scoped_vars, parameter_names) for arg in node.get("args", [])
            ) + ")"
        return ""

    def cpp_decl_type(node, scoped_vars, parameter_names):
        if node and node.get("type") == "Literal":
            raw = node.get("value", "")
            if raw in ("true", "false"):
                return "bool"
            if raw.startswith('"'):
                return "string"
            return "double" if "." in raw else "int"
        if node and node.get("type") == "ArrayLiteral":
            return array_type(node)
        if node and node.get("type") == "CallExpr":
            name = node.get("name")
            if name == "input":
                return "string"
            if name == "len":
                return "int"
            if name == "range":
                return "vector<int>"
        if node and node.get("type") == "BinaryExpr":
            op = node.get("op")
            if op in ("&&", "||", "==", "!=", "<", ">", "<=", ">="):
                return "bool"
            if op in ("/", "**"):
                return "double"
        expression = to_cpp_expr(node, scoped_vars, parameter_names)
        if not expression:
            raise Exception("C++生成エラー: 変数の型を推定できません。")
        return f"std::decay_t<decltype({expression})>"

    def iterable_expression(node, scoped_vars, parameter_names):
        if node and node.get("type") == "ArrayLiteral":
            return to_cpp_expr(node, scoped_vars, parameter_names)
        return to_cpp_expr(node, scoped_vars, parameter_names)

    def collect_scope_declarations(nodes, parameter_names):
        scoped_vars = set()
        declarations = []
        loop_temp_sequence = [0]

        def declare(name, type_expression):
            if name in parameter_names or name in scoped_vars:
                return
            declarations.append(f"    std::optional<{type_expression}> {name};")
            scoped_vars.add(name)

        def visit(body):
            index = 0
            while index < len(body):
                node = body[index]
                typ = node.get("type")

                if typ == "FunctionDef":
                    index += 1
                    continue

                if typ == "AssignmentExpression":
                    name = node["variable"]
                    if name not in scoped_vars and name not in parameter_names:
                        type_expression = cpp_decl_type(node["value"], scoped_vars, parameter_names)
                        declare(name, type_expression)
                    index += 1
                    continue

                if typ == "IfStatement":
                    visit(node.get("body", []))
                    branch_index = index + 1
                    while branch_index < len(body) and body[branch_index].get("type") in ("ElifStatement", "ElseStatement"):
                        visit(body[branch_index].get("body", []))
                        branch_index += 1
                    index = branch_index
                    continue

                if typ in ("ElifStatement", "ElseStatement", "WhileStatement"):
                    visit(node.get("body", []))
                    index += 1
                    continue

                if typ == "ForStatement":
                    name = node["variable"]
                    if name not in scoped_vars and name not in parameter_names:
                        iterable = iterable_expression(node["range"], scoped_vars, parameter_names)
                        element_type = f"typename std::iterator_traits<decltype(std::begin({iterable}))>::value_type"
                        declare(name, element_type)
                    visit(node.get("body", []))
                    index += 1
                    continue

                index += 1

        visit(nodes)
        return declarations, scoped_vars, loop_temp_sequence

    def has_return(nodes):
        for node in nodes:
            if node.get("type") == "ReturnStatement":
                return True
            if isinstance(node.get("body"), list) and has_return(node["body"]):
                return True
        return False

    def walk(nodes, scoped_vars, parameter_names, loop_temp_sequence):
        lines = []
        indent_str = "    "

        for node in nodes:
            typ = node["type"]

            if typ == "AssignmentExpression":
                var = node["variable"]
                cpp_val = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                if var in scoped_vars:
                    lines.append(f'{indent_str}ps_set({var}, {cpp_val}, "{var}");')
                else:
                    lines.append(f"{indent_str}{var} = {cpp_val};")

            elif typ == "CompoundAssignment":
                var = node["variable"]
                op = node["op"]
                cpp_val = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                target = f'ps_get({var}, "{var}")' if var in scoped_vars else var
                lines.append(f"{indent_str}{target} {op} {cpp_val};")

            elif typ == "ArrayAssignStatement":
                name = node["name"]
                base = f'ps_get({name}, "{name}")' if name in scoped_vars else name
                index = to_cpp_expr(node["index"], scoped_vars, parameter_names)
                value = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                lines.append(f"{indent_str}{base}[{index}] = {value};")

            elif typ == "ArrayCompoundAssignStatement":
                name = node["name"]
                base = f'ps_get({name}, "{name}")' if name in scoped_vars else name
                index = to_cpp_expr(node["index"], scoped_vars, parameter_names)
                value = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                lines.append(f"{indent_str}{base}[{index}] {node.get('op', '+=')} {value};")

            elif typ == "PrintStatement":
                value = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                lines.append(f"{indent_str}cout << {value} << endl;")

            elif typ in ("IfStatement", "ElifStatement"):
                prefix = "if" if typ == "IfStatement" else "else if"
                condition = to_cpp_expr(node["condition"], scoped_vars, parameter_names)
                lines.append(f"{indent_str}{prefix} ({condition}) {{")
                lines.extend(walk(node["body"], scoped_vars, parameter_names, loop_temp_sequence))
                lines.append(f"{indent_str}}}")

            elif typ == "ElseStatement":
                lines.append(f"{indent_str}else {{")
                lines.extend(walk(node["body"], scoped_vars, parameter_names, loop_temp_sequence))
                lines.append(f"{indent_str}}}")

            elif typ == "WhileStatement":
                condition = to_cpp_expr(node["condition"], scoped_vars, parameter_names)
                lines.append(f"{indent_str}while ({condition}) {{")
                lines.extend(walk(node["body"], scoped_vars, parameter_names, loop_temp_sequence))
                lines.append(f"{indent_str}}}")

            elif typ == "ForStatement":
                iterable = iterable_expression(node["range"], scoped_vars, parameter_names)
                temp = f"__pstudio_range_item_{loop_temp_sequence[0]}"
                loop_temp_sequence[0] += 1
                while temp in scoped_vars or temp in parameter_names:
                    temp = f"__pstudio_range_item_{loop_temp_sequence[0]}"
                    loop_temp_sequence[0] += 1
                lines.append(f"{indent_str}for (auto&& {temp} : {iterable}) {{")
                loop_var = node["variable"]
                if loop_var in scoped_vars:
                    lines.append(f'{indent_str}    ps_set({loop_var}, {temp}, "{loop_var}");')
                else:
                    lines.append(f"{indent_str}    {loop_var} = {temp};")
                lines.extend(walk(node["body"], scoped_vars, parameter_names, loop_temp_sequence))
                lines.append(f"{indent_str}}}")

            elif typ == "BREAKStatement":
                lines.append(f"{indent_str}break;")
            elif typ == "CONTINUEStatement":
                lines.append(f"{indent_str}continue;")
            elif typ == "ReturnStatement":
                if node.get("value") is None:
                    lines.append(f"{indent_str}return;")
                else:
                    value = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                    lines.append(f"{indent_str}return {value};")

            elif typ == "FunctionDef":
                params = node.get("params", [])
                parameter_names_inner = set(params)
                if params:
                    t_params = ", ".join(f"typename T_{name}" for name in params)
                    param_str = ", ".join(f"T_{name} {name}" for name in params)
                    header = [f"template <{t_params}>"]
                else:
                    param_str = ""
                    header = []
                ret_type = "auto" if has_return(node.get("body", [])) else "void"
                local_declarations, local_scoped_vars, local_loop_sequence = collect_scope_declarations(
                    node.get("body", []), parameter_names_inner
                )
                func_lines = header + [f"{ret_type} {node['name']}({param_str}) {{"]
                func_lines.extend(local_declarations)
                func_lines.extend(walk(
                    node.get("body", []), local_scoped_vars,
                    parameter_names_inner, local_loop_sequence
                ))
                func_lines.append("}")
                functions_buf.append("\n".join(func_lines))

            elif typ == "ExpressionStatement":
                value = to_cpp_expr(node["value"], scoped_vars, parameter_names)
                lines.append(f"{indent_str}{value};")

        return lines

    main_declarations, main_scoped_vars, main_loop_sequence = collect_scope_declarations(
        ast["body"], set()
    )
    main_body = walk(ast["body"], main_scoped_vars, set(), main_loop_sequence)
    final_code = (
        cpp_lines + [""] + functions_buf + [""] + ["int main() {"]
        + main_declarations + main_body + ["    return 0;", "}"]
    )
    return "\n".join(final_code)



# ====================================================
# Portable C++17 ECS project generator
# ====================================================

def _native_cpp_string(value):
    return json.dumps(str(value), ensure_ascii=False)


def _native_cpp_literal_type(node):
    if not isinstance(node, dict):
        raise Exception("Native ECS: invalid Component default.")
    if node.get("type") == "Literal":
        raw = str(node.get("value", ""))
        if raw in ("true", "false"):
            return "bool"
        if raw.startswith('"'):
            return "std::string"
        return "double" if "." in raw else "std::int64_t"
    if node.get("type") == "ArrayLiteral":
        elements = node.get("elements", [])
        if not elements:
            return "std::vector<std::int64_t>"
        element_types = {_native_cpp_literal_type(item) for item in elements}
        if len(element_types) != 1:
            raise Exception("Native ECS: array defaults must contain one consistent scalar type.")
        element_type = next(iter(element_types))
        if element_type.startswith("std::vector<"):
            raise Exception("Native ECS: nested array defaults are not supported in this stage.")
        return f"std::vector<{element_type}>"
    raise Exception("Native ECS: Component defaults must be literal values or literal arrays.")


def _native_cpp_literal(node):
    kind = node.get("type")
    if kind == "Literal":
        raw = str(node.get("value", ""))
        if raw.startswith('"'):
            try:
                return _native_cpp_string(json.loads(raw))
            except Exception as exc:
                raise Exception("Native ECS: invalid string literal.") from exc
        if raw in ("true", "false"):
            return raw
        number = float(raw) if "." in raw else int(raw)
        if not math.isfinite(float(number)):
            raise Exception("Native ECS: numeric literal must be finite.")
        return raw
    if kind == "ArrayLiteral":
        cpp_type = _native_cpp_literal_type(node)
        values = ", ".join(_native_cpp_literal(item) for item in node.get("elements", []))
        return f"{cpp_type}{{{values}}}"
    raise Exception("Native ECS: unsupported literal value.")


def _native_expr_type(node, local_types, binding_types, field_types):
    kind = node.get("type")
    if kind == "Literal":
        raw = str(node.get("value", ""))
        if raw in ("true", "false"):
            return "bool"
        if raw.startswith('"'):
            return "std::string"
        return "double" if "." in raw else "std::int64_t"
    if kind == "ArrayLiteral":
        return _native_cpp_literal_type(node)
    if kind == "Variable":
        name = node.get("value")
        if name in local_types:
            return local_types[name]
        if name == "dt":
            return "double"
        if name == "entity":
            return "pstudio::ecs::Entity"
        if name in binding_types:
            return binding_types[name]
        raise Exception(f"Native ECS: unknown System variable '{name}'.")
    if kind == "MemberExpr":
        owner = node.get("object", {})
        if owner.get("type") != "Variable":
            raise Exception("Native ECS: member access must use a Component binding.")
        component_type = binding_types.get(owner.get("value"))
        if component_type is None:
            raise Exception(f"Native ECS: '{owner.get('value')}' is not a Component binding.")
        field = node.get("property")
        result = field_types.get(component_type, {}).get(field)
        if result is None:
            raise Exception(f"Native ECS: Component '{component_type}' has no Field '{field}'.")
        return result
    if kind == "IndexExpr":
        base_type = local_types.get(node.get("name"))
        if not base_type or not base_type.startswith("std::vector<"):
            raise Exception("Native ECS: array indexing currently requires a local vector.")
        return base_type[len("std::vector<"):-1]
    if kind in ("UnaryExpr", "PostfixExpr"):
        inner = node.get("right") if kind == "UnaryExpr" else node.get("value")
        value_type = _native_expr_type(inner, local_types, binding_types, field_types)
        return "bool" if kind == "UnaryExpr" and node.get("op") == "!" else value_type
    if kind == "BinaryExpr":
        op = node.get("op")
        left = _native_expr_type(node.get("left"), local_types, binding_types, field_types)
        right = _native_expr_type(node.get("right"), local_types, binding_types, field_types)
        if op in ("&&", "||", "==", "!=", "<", ">", "<=", ">="):
            return "bool"
        if op in ("/", "**"):
            return "double"
        if left == "std::string" and right == "std::string" and op == "+":
            return "std::string"
        if left == "double" or right == "double":
            return "double"
        return left
    if kind == "CallExpr":
        name = node.get("name")
        if name == "len" and len(node.get("args", [])) == 1:
            return "std::size_t"
        if name == "range":
            return "std::vector<std::int64_t>"
        raise Exception(f"Native ECS: function '{name}' is not yet supported inside native Systems.")
    raise Exception(f"Native ECS: expression '{kind}' is not supported.")


def _native_merge_numeric_types(left, right):
    if left == right:
        return left
    numeric = {"std::int64_t", "double"}
    if left in numeric and right in numeric:
        return "double"
    raise Exception(f"Native ECS: local variable type changes from {left} to {right} are not supported.")


def _native_system_locals(nodes, binding_types, field_types):
    local_types = {}

    def visit(body):
        for node in body:
            kind = node.get("type")
            if kind == "AssignmentExpression":
                name = node.get("variable")
                if name in binding_types or name in ("entity", "dt"):
                    raise Exception(f"Native ECS: System binding '{name}' cannot be reassigned.")
                inferred = _native_expr_type(node.get("value"), local_types, binding_types, field_types)
                local_types[name] = _native_merge_numeric_types(local_types[name], inferred) if name in local_types else inferred
            elif kind == "CompoundAssignment":
                name = node.get("variable")
                if name not in local_types:
                    raise Exception(f"Native ECS: local '{name}' must be assigned before compound assignment.")
                inferred = _native_expr_type(node.get("value"), local_types, binding_types, field_types)
                local_types[name] = _native_merge_numeric_types(local_types[name], inferred)
            elif kind == "ForStatement":
                name = node.get("variable")
                if name in binding_types or name in ("entity", "dt"):
                    raise Exception(f"Native ECS: loop variable '{name}' shadows a System binding.")
                iterable_type = _native_expr_type(node.get("range"), local_types, binding_types, field_types)
                if iterable_type != "std::vector<std::int64_t>":
                    raise Exception("Native ECS: for loops currently require range(...).")
                local_types.setdefault(name, "std::int64_t")
                visit(node.get("body", []))
            elif kind in ("IfStatement", "ElifStatement", "ElseStatement", "WhileStatement"):
                visit(node.get("body", []))
            elif kind in ("ArrayAssignStatement", "ArrayCompoundAssignStatement"):
                name = node.get("name")
                if name not in local_types or not local_types[name].startswith("std::vector<"):
                    raise Exception("Native ECS: array assignment requires a local vector.")
            elif kind in ("FunctionDef", "ComponentDef", "SystemDef"):
                raise Exception(f"Native ECS: nested {kind} declarations are not supported inside a System.")
    visit(nodes)
    return local_types


def _native_cpp_expr(node, local_names, binding_names):
    kind = node.get("type")
    if kind == "Literal":
        return _native_cpp_literal(node)
    if kind == "ArrayLiteral":
        return _native_cpp_literal(node)
    if kind == "Variable":
        name = node.get("value")
        if name in local_names:
            return f"pstudio::ecs::get({name}, {_native_cpp_string(name)})"
        if name in binding_names or name in ("entity", "dt", "true", "false"):
            return name
        raise Exception(f"Native ECS: unknown variable '{name}'.")
    if kind == "MemberExpr":
        return _native_cpp_expr(node.get("object"), local_names, binding_names) + "." + node["property"]
    if kind == "IndexExpr":
        base = f"pstudio::ecs::get({node['name']}, {_native_cpp_string(node['name'])})" if node["name"] in local_names else node["name"]
        return f"{base}[{_native_cpp_expr(node['index'], local_names, binding_names)}]"
    if kind == "UnaryExpr":
        op = node.get("op")
        right = _native_cpp_expr(node.get("right"), local_names, binding_names)
        return f"(!pstudio::ecs::truthy({right}))" if op == "!" else f"({op}{right})"
    if kind == "PostfixExpr":
        return f"({_native_cpp_expr(node['value'], local_names, binding_names)}{node['op']})"
    if kind == "BinaryExpr":
        op = node.get("op")
        left = _native_cpp_expr(node["left"], local_names, binding_names)
        right = _native_cpp_expr(node["right"], local_names, binding_names)
        if op in ("&&", "||"):
            return f"(pstudio::ecs::truthy({left}) {op} pstudio::ecs::truthy({right}))"
        if op == "/":
            return f"pstudio::ecs::ps_div({left}, {right})"
        if op == "%":
            return f"pstudio::ecs::ps_mod({left}, {right})"
        if op == "**":
            return f"std::pow({left}, {right})"
        return f"({left} {op} {right})"
    if kind == "CallExpr":
        name = node.get("name")
        args = [_native_cpp_expr(arg, local_names, binding_names) for arg in node.get("args", [])]
        if name == "len" and len(args) == 1:
            return f"pstudio::ecs::len({args[0]})"
        if name == "range" and 1 <= len(args) <= 3:
            return f"pstudio::ecs::range({', '.join(args)})"
        raise Exception(f"Native ECS: function '{name}' is not yet supported inside a System.")
    raise Exception(f"Native ECS: expression '{kind}' is not supported.")


def _native_generate_system_body(nodes, local_names, binding_names, indent=3, sequence=None):
    sequence = sequence if sequence is not None else [0]
    pad = "    " * indent
    output = []
    index = 0
    while index < len(nodes):
        node = nodes[index]
        kind = node.get("type")
        if kind == "IfStatement":
            condition = _native_cpp_expr(node["condition"], local_names, binding_names)
            output.append(pad + f"if (pstudio::ecs::truthy({condition})) {{")
            output.extend(_native_generate_system_body(node.get("body", []), local_names, binding_names, indent + 1, sequence))
            output.append(pad + "}")
            index += 1
            while index < len(nodes) and nodes[index].get("type") in ("ElifStatement", "ElseStatement"):
                branch = nodes[index]
                if branch["type"] == "ElifStatement":
                    condition = _native_cpp_expr(branch["condition"], local_names, binding_names)
                    output[-1] = pad + f"}} else if (pstudio::ecs::truthy({condition})) {{"
                else:
                    output[-1] = pad + "} else {"
                output.extend(_native_generate_system_body(branch.get("body", []), local_names, binding_names, indent + 1, sequence))
                output.append(pad + "}")
                index += 1
            continue
        if kind in ("ElifStatement", "ElseStatement"):
            raise Exception("Native ECS: elif/else must immediately follow an if branch.")
        if kind == "AssignmentExpression":
            name = node["variable"]
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + f"pstudio::ecs::set({name}, {value}, {_native_cpp_string(name)});")
        elif kind == "CompoundAssignment":
            name = node["variable"]
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            target = f"pstudio::ecs::get({name}, {_native_cpp_string(name)})"
            output.append(pad + f"{target} {node['op']} {value};")
        elif kind == "MemberAssignment":
            target = _native_cpp_expr(node["target"], local_names, binding_names)
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + f"{target} = {value};")
        elif kind == "MemberCompoundAssignment":
            target = _native_cpp_expr(node["target"], local_names, binding_names)
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + f"{target} {node['op']} {value};")
        elif kind == "ArrayAssignStatement":
            target = f"pstudio::ecs::get({node['name']}, {_native_cpp_string(node['name'])})"
            index_expr = _native_cpp_expr(node["index"], local_names, binding_names)
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + f"{target}[{index_expr}] = {value};")
        elif kind == "ArrayCompoundAssignStatement":
            target = f"pstudio::ecs::get({node['name']}, {_native_cpp_string(node['name'])})"
            index_expr = _native_cpp_expr(node["index"], local_names, binding_names)
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + f"{target}[{index_expr}] {node['op']} {value};")
        elif kind == "PrintStatement":
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + f"std::cout << {value} << std::endl;")
        elif kind == "ExpressionStatement":
            value = _native_cpp_expr(node["value"], local_names, binding_names)
            output.append(pad + value + ";")
        elif kind == "WhileStatement":
            sequence[0] += 1
            guard = f"pstudio_internal_while_guard_{sequence[0]}"
            condition = _native_cpp_expr(node["condition"], local_names, binding_names)
            output.append(pad + f"std::size_t {guard} = 0;")
            output.append(pad + f"while (pstudio::ecs::truthy({condition})) {{")
            output.append(pad + f"    if (++{guard} > 1000) throw std::runtime_error(\"ps while iteration limit exceeded\");")
            output.extend(_native_generate_system_body(node.get("body", []), local_names, binding_names, indent + 1, sequence))
            output.append(pad + "}")
        elif kind == "ForStatement":
            sequence[0] += 1
            iterator = f"pstudio_internal_range_{sequence[0]}"
            guard = f"pstudio_internal_for_guard_{sequence[0]}"
            iterable = _native_cpp_expr(node["range"], local_names, binding_names)
            name = node["variable"]
            output.append(pad + f"std::size_t {guard} = 0;")
            output.append(pad + f"for (auto&& {iterator} : {iterable}) {{")
            output.append(pad + f"    if (++{guard} > 100000) throw std::runtime_error(\"ps for iteration limit exceeded\");")
            output.append(pad + f"    pstudio::ecs::set({name}, {iterator}, {_native_cpp_string(name)});")
            output.extend(_native_generate_system_body(node.get("body", []), local_names, binding_names, indent + 1, sequence))
            output.append(pad + "}")
        elif kind == "BREAKStatement":
            output.append(pad + "break;")
        elif kind == "CONTINUEStatement":
            output.append(pad + "continue;")
        elif kind == "ReturnStatement":
            value = node.get("value")
            output.append(pad + ("return;" if value is None else "return " + _native_cpp_expr(value, local_names, binding_names) + ";"))
        else:
            raise Exception(f"Native ECS: statement '{kind}' is not yet supported.")
        index += 1
    return output


def generate_native_ecs_sources(parsed_scripts):
    components = {}
    systems = []
    for filename, tree in parsed_scripts.items():
        for node in tree.get("body", []):
            if node.get("type") == "ComponentDef":
                name = node["name"]
                if name in components:
                    raise Exception(f"Native ECS: Component '{name}' is declared more than once.")
                components[name] = node
            elif node.get("type") == "SystemDef":
                systems.append((filename, node))
    if not components and not systems:
        raise Exception("Native ECS export requires at least one component or system declaration.")
    system_names = set()
    for filename, node in systems:
        if node["name"] in system_names:
            raise Exception(f"Native ECS: System '{node['name']}' is declared more than once.")
        system_names.add(node["name"])
    fields = {
        "Transform": {
            "x": "double", "y": "double", "z": "double",
            "rotationX": "double", "rotationY": "double", "rotationZ": "double",
            "scaleX": "double", "scaleY": "double", "scaleZ": "double"
        },
        "SceneObjectRef": {"sceneObjectId": "std::string"}
    }
    component_definitions = []
    for name, node in components.items():
        field_types = {}
        field_lines = []
        for field in node.get("body", []):
            if field.get("type") != "AssignmentExpression":
                raise Exception(f"Native ECS: Component '{name}' contains an unsupported statement.")
            field_name = field["variable"]
            value = field["value"]
            field_type = _native_cpp_literal_type(value)
            field_types[field_name] = field_type
            field_lines.append(f"    {field_type} {field_name} = {_native_cpp_literal(value)};")
        fields[name] = field_types
        component_definitions.append("struct " + name + " {\n" + "\n".join(field_lines) + "\n};")
    system_bodies = []
    for filename, node in systems:
        component_names = node.get("components", [])
        binding_types = {_ecs_binding_name(name): name for name in component_names}
        local_types = _native_system_locals(node.get("body", []), binding_types, fields)
        local_names = set(local_types)
        for name in component_names:
            if name not in fields:
                raise Exception(f"Native ECS: unknown Component '{name}'.")
        params = ", ".join(
            f"{name if name in ('Transform', 'SceneObjectRef') else name}& {_ecs_binding_name(name)}"
            for name in component_names
        )
        declarations = [f"std::optional<{local_types[name]}> {name};" for name in sorted(local_types)]
        body = _native_generate_system_body(node.get("body", []), local_names, set(binding_types) | {"entity", "dt"})
        system_id = _native_cpp_string(filename + "::" + node["name"])
        function = [
            f"    scheduler.add({system_id}, 0, [](pstudio::ecs::World& world, double dt) {{",
            f"        world.each<{', '.join(component_names)}>([&](pstudio::ecs::Entity entity, {params}) {{"
        ]
        function.extend("            " + line.strip() for line in declarations)
        function.extend(body)
        function.extend(["        });", "    });"])
        system_bodies.append("\n".join(function))
    header = "\n".join([
        "#pragma once",
        '#include "pstudio/ecs.hpp"',
        "namespace PStudioGenerated {",
        "using pstudio::ecs::Transform;",
        "using pstudio::ecs::SceneObjectRef;",
        "using pstudio::ecs::Entity;",
        "using pstudio::ecs::World;",
        "using pstudio::ecs::Scheduler;",
        *component_definitions,
        "Entity create_entity(World& world);",
        "void register_systems(Scheduler& scheduler);",
        "}",
        ""
    ])
    cpp = "\n".join([
        '#include "pstudio_generated.hpp"',
        "#include <iostream>",
        "#include <optional>",
        "namespace PStudioGenerated {",
        "Entity create_entity(World& world) {",
        "    const Entity entity = world.create_entity();",
        "    world.add<Transform>(entity, Transform{});",
        "    world.add<SceneObjectRef>(entity, SceneObjectRef{});",
        *[f"    world.add<{name}>(entity, {name}{{}});" for name in components],
        "    return entity;",
        "}",
        "void register_systems(Scheduler& scheduler) {",
        *system_bodies,
        "}",
        "}",
        ""
    ])
    main_cpp = "\n".join([
        '#include "pstudio_generated.hpp"',
        "#include <iostream>",
        "int main() {",
        "    pstudio::ecs::World world;",
        "    pstudio::ecs::Scheduler scheduler;",
        "    PStudioGenerated::register_systems(scheduler);",
        "    const auto entity = PStudioGenerated::create_entity(world);",
        "    scheduler.update(world, 1.0 / 60.0);",
        "    const auto& transform = world.get<pstudio::ecs::Transform>(entity);",
        '    std::cout << "PStudio native ECS ready; entities=" << world.entity_count() << ", x=" << transform.x << ", y=" << transform.y << ", z=" << transform.z << std::endl;',
        "    return 0;",
        "}",
        ""
    ])
    cmake = "\n".join([
        "cmake_minimum_required(VERSION 3.16)",
        "project(PStudioNativeECS LANGUAGES CXX)",
        "set(CMAKE_CXX_STANDARD 17)",
        "set(CMAKE_CXX_STANDARD_REQUIRED ON)",
        "set(CMAKE_CXX_EXTENSIONS OFF)",
        "add_library(pstudio_native_ecs STATIC src/pstudio_generated.cpp)",
        "target_include_directories(pstudio_native_ecs PUBLIC native/include src)",
        "add_executable(pstudio_native_sample src/main.cpp)",
        "target_link_libraries(pstudio_native_sample PRIVATE pstudio_native_ecs)",
        ""
    ])
    readme = """# PStudio Native ECS module

This CMake project contains C++17 Component data types and System callbacks generated from the supported ps ECS subset. Supported operations include Component member access/assignment, scalar locals, arithmetic and logical expressions, if/else, while, range loops, len and range. Unsupported game APIs and arbitrary helper-function calls are rejected during export.

Build on the target machine with a C++17 toolchain and CMake:

    cmake -S . -B build
    cmake --build build --config Release

For Android, configure CMake with the Android NDK toolchain file and ABI/API settings. Windows and macOS builds use the target platform's CMake generator and compiler.

Scope: this is a native ECS module/sample executable, not yet a complete PStudio game port. Browser Three.js rendering, GLB loading, input, audio, legacy JS physics and gameplay APIs are not native in this package. Unsupported System expressions/functions are rejected during export rather than silently stubbed.
"""
    return {
        "CMakeLists.txt": cmake,
        "README.md": readme,
        "native/include/pstudio/ecs.hpp": None,
        "src/pstudio_generated.hpp": header,
        "src/pstudio_generated.cpp": cpp,
        "src/main.cpp": main_cpp,
    }


# ====================================================
# ps Discord Runtime
# ====================================================

MAX_DISCORD_PS_STEPS = 100000
MAX_DISCORD_PS_OUTPUT_BYTES = 1024 * 1024

_ps_discord_bot = None
_ps_discord_lock = threading.Lock()
_ps_discord_handlers = {}


class PsReturnSignal(Exception):
    def __init__(self, value=None):
        self.value = value


class PsBreakSignal(Exception):
    pass


class PsContinueSignal(Exception):
    pass


class PsFunction:
    def __init__(self, node, interpreter):
        self.node = node
        self.interpreter = interpreter

    def call(self, args):
        params = self.node.get("params", [])
        if len(args) != len(params):
            raise Exception(
                f"関数 {self.node['name']}() は引数を {len(params)} 個指定してください。"
            )

        env = dict(self.interpreter.globals)

        for i, name in enumerate(params):
            env[name] = args[i]

        self.interpreter._begin_execution()
        try:
            try:
                self.interpreter.execute_block(
                    self.node.get("body", []),
                    env
                )
            except PsReturnSignal as e:
                return e.value
            return None
        finally:
            self.interpreter._end_execution()


class PsDiscordInterpreter:

    def __init__(self, tree):
        self.tree = tree
        self.globals = {}
        self.functions = {}
        self.output = []
        self.output_bytes = 0
        self.max_output_bytes = MAX_DISCORD_PS_OUTPUT_BYTES
        self.max_steps = MAX_DISCORD_PS_STEPS
        self._execution_depth = 0
        self._execution_steps = 0
        self._if_chain_end = 0

        for node in tree.get("body", []):
            if node.get("type") == "FunctionDef":
                self.functions[node["name"]] = PsFunction(
                    node,
                    self
                )

    def _begin_execution(self):
        if self._execution_depth == 0:
            self._execution_steps = 0
        self._execution_depth += 1

    def _end_execution(self):
        self._execution_depth = max(0, self._execution_depth - 1)

    def _consume_step(self):
        self._execution_steps += 1
        if self._execution_steps > self.max_steps:
            raise Exception(
                f"Discord ps実行が命令上限（{self.max_steps}）を超えたため停止しました。"
            )

    def eval_expr(self, node, env):
        if node is None:
            return None

        typ = node.get("type")

        if typ == "Literal":
            raw = node.get("value", "")

            if (
                raw.startswith('"')
                and raw.endswith('"')
            ):
                value = raw[1:-1]
                result = []
                i = 0
                mapping = {
                    "n": "\n",
                    "t": "\t",
                    "r": "\r",
                    '"': '"',
                    "\\": "\\"
                }

                while i < len(value):
                    if value[i] != "\\":
                        result.append(value[i])
                        i += 1
                        continue

                    i += 1

                    if i >= len(value):
                        result.append("\\")
                        break

                    esc = value[i]

                    if esc in mapping:
                        result.append(mapping[esc])
                    else:
                        result.append("\\" + esc)

                    i += 1

                return "".join(result)

            if "." in raw:
                try:
                    return float(raw)
                except ValueError:
                    return raw

            try:
                return int(raw)
            except ValueError:
                return raw

        if typ == "Variable":
            name = node["value"]

            if name in env:
                return env[name]

            if name in self.globals:
                return self.globals[name]

            if name == "true":
                return True

            if name == "false":
                return False

            raise Exception(
                f"未定義の変数: {name}"
            )

        if typ == "ArrayLiteral":
            return [
                self.eval_expr(x, env)
                for x in node.get("elements", [])
            ]

        if typ == "IndexExpr":
            base = env.get(
                node["name"],
                self.globals.get(node["name"])
            )

            index = self.eval_expr(
                node["index"],
                env
            )

            return base[index]

        if typ == "UnaryExpr":
            value = self.eval_expr(
                node["right"],
                env
            )

            if node["op"] == "!":
                return not bool(value)
            if node["op"] == "+":
                return +value
            if node["op"] == "-":
                return -value
            if node["op"] == "~":
                return ~value
            if node["op"] in ("++", "--"):
                updated = value + 1 if node["op"] == "++" else value - 1
                self.assign_target(node["right"], updated, env)
                return updated

            return value

        if typ == "PostfixExpr":
            target = node["value"]
            old_value = self.eval_expr(target, env)
            new_value = old_value + 1 if node["op"] == "++" else old_value - 1
            self.assign_target(target, new_value, env)
            return old_value

        if typ == "BinaryExpr":
            op = node["op"]

            left = self.eval_expr(
                node["left"],
                env
            )

            if op == "&&":
                if not bool(left):
                    return False

                return bool(
                    self.eval_expr(
                        node["right"],
                        env
                    )
                )

            if op == "||":
                if bool(left):
                    return True

                return bool(
                    self.eval_expr(
                        node["right"],
                        env
                    )
                )

            right = self.eval_expr(
                node["right"],
                env
            )

            if op == "+":
                return left + right

            if op == "-":
                return left - right

            if op == "*":
                return left * right

            if op == "/":
                if right == 0:
                    raise ZeroDivisionError("division by zero")
                return left / right

            if op == "%":
                return left % right

            if op == "**":
                return left ** right

            if op == "&":
                return left & right

            if op == "|":
                return left | right

            if op == "^":
                return left ^ right

            if op == "<<":
                return left << right

            if op == ">>":
                return left >> right

            if op == "==":
                return left == right

            if op == "!=":
                return left != right

            if op == "<":
                return left < right

            if op == ">":
                return left > right

            if op == "<=":
                return left <= right

            if op == ">=":
                return left >= right

            raise Exception(
                f"未対応の演算子: {op}"
            )

        if typ == "CallExpr":
            name = node["name"]

            args = [
                self.eval_expr(arg, env)
                for arg in node.get("args", [])
            ]

            return self.call_builtin(
                name,
                args,
                env
            )

        raise Exception(
            f"未対応の式: {typ}"
        )

    def call_builtin(self, name, args, env):
        global _ps_discord_bot

        if name == "len":
            if len(args) != 1:
                raise Exception(
                    "len() は引数を1個指定してください。"
                )

            return len(args[0])

        if name == "range":
            if len(args) == 1:
                return range(int(args[0]))
            if len(args) == 2:
                return range(int(args[0]), int(args[1]))
            if len(args) == 3:
                step = int(args[2])
                # C++ backend の range(…, step=0) と意味を一致させる。
                if step == 0:
                    return range(0)
                return range(int(args[0]), int(args[1]), step)
            raise Exception(
                "range() の引数は1〜3個です。"
            )

        if name == "input":
            if len(args) > 1:
                raise Exception(
                    "input() の引数は0〜1個です。"
                )

            if args:
                print(str(args[0]), end="")

            return input()

        # ================================================
        # Discord: start
        # ================================================

        if name == "discord_start":
            if not PS_DISCORD_AVAILABLE:
                raise Exception(
                    "discord_runtime.py が利用できません。"
                )

            if len(args) != 1 or not args[0]:
                raise Exception(
                    "discord_start() にはBot Tokenが必要です。"
                )

            with _ps_discord_lock:
                if _ps_discord_bot is not None:
                    return True

                bot = DiscordBot(
                    str(args[0])
                )

                for event_name, fn in list(
                    _ps_discord_handlers.items()
                ):
                    self._attach_discord_handler(
                        bot,
                        event_name,
                        fn
                    )

                _ps_discord_bot = bot

                def runner():
                    global _ps_discord_bot

                    try:
                        bot.start(
                            background=False
                        )

                    except Exception as e:
                        print(
                            f"[ps Discord] {e}"
                        )

                    finally:
                        with _ps_discord_lock:
                            if _ps_discord_bot is bot:
                                _ps_discord_bot = None

                threading.Thread(
                    target=runner,
                    daemon=True
                ).start()

            return True

        # ================================================
        # Discord: stop
        # ================================================

        if name == "discord_stop":
            with _ps_discord_lock:
                bot = _ps_discord_bot
                _ps_discord_bot = None

            if bot is not None:
                try:
                    bot.stop()
                except Exception:
                    pass

            return True

        # ================================================
        # Discord: status
        # ================================================

        if name == "discord_status":
            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return {
                    "running": False
                }

            return {
                "running": True
            }

        # ================================================
        # Discord: send
        # ================================================

        if name == "discord_send":
            if len(args) != 2:
                raise Exception(
                    "discord_send() は "
                    "チャンネルIDとメッセージの2個の引数が必要です。"
                )

            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                raise Exception(
                    "Discord Botが起動していません。"
                )

            channel_id = str(args[0])
            content = str(args[1])

            bot.send_message(
                channel_id,
                content
            )

            return True

        # ================================================
        # Discord: event handler
        # ================================================

        if name == "discord_on":
            if len(args) != 2:
                raise Exception(
                    "discord_on() は "
                    "イベント名と関数名の2個の引数が必要です。"
                )

            event_name = str(args[0])
            function_name = str(args[1])

            if function_name not in self.functions:
                raise Exception(
                    f"関数が見つかりません: {function_name}"
                )

            fn = self.functions[
                function_name
            ]

            _ps_discord_handlers[
                event_name
            ] = fn

            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is not None:
                self._attach_discord_handler(
                    bot,
                    event_name,
                    fn
                )

            return True

        # ================================================
        # Discord: reply
        # ================================================

        if name == "discord_reply":
            if len(args) != 1:
                raise Exception(
                    "discord_reply() は "
                    "メッセージ内容を1個指定してください。"
                )

            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                raise Exception(
                    "Discord Botが起動していません。"
                )

            event = getattr(
                bot,
                "current_event",
                None
            )

            if event is None:
                raise Exception(
                    "現在処理中のDiscordイベントがありません。"
                )

            message = getattr(
                event,
                "message",
                None
            )

            if message is None:
                raise Exception(
                    "現在のイベントにメッセージがありません。"
                )

            channel_id = getattr(
                message,
                "channel_id",
                None
            )

            if channel_id is None:
                raise Exception(
                    "チャンネルIDを取得できません。"
                )

            bot.send_message(
                str(channel_id),
                str(args[0])
            )

            return True

        # ================================================
        # Discord: message content
        # ================================================

        if name == "discord_content":
            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return ""

            event = getattr(
                bot,
                "current_event",
                None
            )

            if event is None:
                return ""

            message = getattr(
                event,
                "message",
                None
            )

            if message is None:
                return ""

            return str(
                getattr(
                    message,
                    "content",
                    ""
                )
            )

        # ================================================
        # Discord: channel ID
        # ================================================

        if name == "discord_channel_id":
            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return ""

            event = getattr(
                bot,
                "current_event",
                None
            )

            if event is None:
                return ""

            message = getattr(
                event,
                "message",
                None
            )

            if message is None:
                return ""

            return str(
                getattr(
                    message,
                    "channel_id",
                    ""
                )
            )

        # ================================================
        # Discord: message ID
        # ================================================

        if name == "discord_message_id":
            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return ""

            event = getattr(
                bot,
                "current_event",
                None
            )

            if event is None:
                return ""

            message = getattr(
                event,
                "message",
                None
            )

            if message is None:
                return ""

            return str(
                getattr(
                    message,
                    "id",
                    ""
                )
            )

        # ================================================
        # Discord: author ID
        # ================================================

        if name == "discord_author_id":
            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return ""

            event = getattr(
                bot,
                "current_event",
                None
            )

            if event is None:
                return ""

            message = getattr(
                event,
                "message",
                None
            )

            if message is None:
                return ""

            author = getattr(
                message,
                "author",
                None
            )

            if author is None:
                return ""

            return str(
                getattr(
                    author,
                    "id",
                    ""
                )
            )

        # ================================================
        # Discord: guild ID
        # ================================================

        if name == "discord_guild_id":
            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return ""

            event = getattr(
                bot,
                "current_event",
                None
            )

            if event is None:
                return ""

            message = getattr(
                event,
                "message",
                None
            )

            if message is None:
                return ""

            guild_id = getattr(
                message,
                "guild_id",
                None
            )

            if guild_id is None:
                return ""

            return str(guild_id)

        # ================================================
        # Discord: event
        # ================================================

        if name == "discord_event":
            if len(args) != 1:
                raise Exception(
                    "discord_event() は "
                    "イベント名を1個指定してください。"
                )

            event_name = str(args[0])

            with _ps_discord_lock:
                bot = _ps_discord_bot

            if bot is None:
                return False

            return (
                getattr(
                    bot,
                    "current_event_name",
                    ""
                )
                == event_name
            )

        # ================================================
        # User function
        # ================================================

        if name in self.functions:
            return self.functions[name].call(args)

        raise Exception(
            f"未定義の関数です: {name}"
        )

    def _attach_discord_handler(
        self,
        bot,
        event_name,
        fn
    ):
        def callback(event):
            try:
                bot.current_event = event
                bot.current_event_name = event_name

                args = []

                if event_name == "message":
                    args = [
                        self._discord_message_dict(
                            event
                        )
                    ]

                fn.call(args)

            except Exception as e:
                print(
                    f"[ps Discord handler:{event_name}] "
                    f"{e}"
                )

        bot.on(
            event_name,
            callback
        )

    def _discord_message_dict(self, event):
        message = getattr(
            event,
            "message",
            None
        )

        if message is None:
            return {}

        author = getattr(
            message,
            "author",
            None
        )

        return {
            "content": getattr(
                message,
                "content",
                ""
            ),
            "channel_id": str(
                getattr(
                    message,
                    "channel_id",
                    ""
                )
            ),
            "message_id": str(
                getattr(
                    message,
                    "id",
                    ""
                )
            ),
            "author_id": (
                str(
                    getattr(
                        author,
                        "id",
                        ""
                    )
                )
                if author is not None
                else ""
            ),
            "guild_id": (
                str(
                    getattr(
                        message,
                        "guild_id",
                        ""
                    )
                )
                if getattr(
                    message,
                    "guild_id",
                    None
                ) is not None
                else ""
            )
        }

    # ====================================================
    # Execution
    # ====================================================

    def assign_target(self, target, value, env):
        if target.get("type") == "Variable":
            env[target["value"]] = value
            return
        if target.get("type") == "IndexExpr":
            name = target["name"]
            base = env.get(name, self.globals.get(name))
            if base is None:
                raise Exception(f"未定義の配列: {name}")
            index = self.eval_expr(target["index"], env)
            base[index] = value
            return
        raise Exception("代入対象は変数または配列要素である必要があります。")

    def execute_node(self, node, env):
        typ = node["type"]

        if typ == "PrintStatement":
            value = self.eval_expr(
                node["value"],
                env
            )

            text = str(value)
            text_bytes = len(text.encode("utf-8"))
            separator_bytes = 1 if self.output else 0
            if self.output_bytes + separator_bytes + text_bytes > self.max_output_bytes:
                raise Exception(
                    f"Discord ps出力が上限（{self.max_output_bytes} bytes）を超えました。"
                )

            self.output.append(text)
            self.output_bytes += separator_bytes + text_bytes

            print(text)

            return

        if typ == "AssignmentExpression":
            value = self.eval_expr(node["value"], env)
            env[node["variable"]] = value
            return

        if typ == "CompoundAssignment":
            name = node["variable"]
            if name not in env and name not in self.globals:
                raise Exception(f"未定義の変数: {name}")
            current = env.get(name, self.globals.get(name))
            value = self.eval_expr(node["value"], env)
            op = node["op"][:-1]
            result = self.eval_expr({"type": "BinaryExpr", "op": op, "left": {"type": "Literal", "value": str(current)}, "right": {"type": "Literal", "value": str(value)}}, env) if False else None
            if op == "+": result = current + value
            elif op == "-": result = current - value
            elif op == "*": result = current * value
            elif op == "/":
                if value == 0:
                    raise ZeroDivisionError("division by zero")
                result = current / value
            elif op == "%": result = current % value
            elif op == "&": result = current & value
            elif op == "|": result = current | value
            elif op == "^": result = current ^ value
            elif op == "<<": result = current << value
            elif op == ">>": result = current >> value
            else: raise Exception(f"未対応の複合代入演算子: {node['op']}")
            env[name] = result
            return

        if typ in ("ArrayAssignStatement", "ArrayCompoundAssignStatement"):
            name = node["name"]
            if name not in env and name not in self.globals:
                raise Exception(f"未定義の配列: {name}")
            base = env.get(name, self.globals.get(name))
            index = self.eval_expr(node["index"], env)
            value = self.eval_expr(node["value"], env)
            if typ == "ArrayAssignStatement":
                base[index] = value
                return
            current = base[index]
            op = node["op"][:-1]
            if op == "+": base[index] = current + value
            elif op == "-": base[index] = current - value
            elif op == "*": base[index] = current * value
            elif op == "/":
                if value == 0:
                    raise ZeroDivisionError("division by zero")
                base[index] = current / value
            elif op == "%": base[index] = current % value
            elif op == "&": base[index] = current & value
            elif op == "|": base[index] = current | value
            elif op == "^": base[index] = current ^ value
            elif op == "<<": base[index] = current << value
            elif op == ">>": base[index] = current >> value
            else: raise Exception(f"未対応の配列複合代入演算子: {node['op']}")
            return

        if typ == "ExpressionStatement":
            self.eval_expr(
                node["value"],
                env
            )

            return

        if typ == "IfStatement":
            if self.eval_expr(
                node["condition"],
                env
            ):
                self.execute_block(
                    node["body"],
                    env
                )

            return

        if typ == "ElifStatement":
            if self.eval_expr(
                node["condition"],
                env
            ):
                self.execute_block(
                    node["body"],
                    env
                )

            return

        if typ == "ElseStatement":
            self.execute_block(
                node["body"],
                env
            )

            return

        if typ == "WhileStatement":
            while self.eval_expr(
                node["condition"],
                env
            ):
                self._consume_step()
                try:
                    self.execute_block(
                        node["body"],
                        env
                    )

                except PsBreakSignal:
                    break

                except PsContinueSignal:
                    continue

            return

        if typ == "ForStatement":
            iterable = self.eval_expr(
                node["range"],
                env
            )

            for value in iterable:
                self._consume_step()
                env[
                    node["variable"]
                ] = value

                try:
                    self.execute_block(
                        node["body"],
                        env
                    )

                except PsBreakSignal:
                    break

                except PsContinueSignal:
                    continue

            return

        if typ == "BREAKStatement":
            raise PsBreakSignal()

        if typ == "CONTINUEStatement":
            raise PsContinueSignal()

        if typ == "ReturnStatement":
            value = None

            if node.get("value") is not None:
                value = self.eval_expr(
                    node["value"],
                    env
                )

            raise PsReturnSignal(value)

        if typ == "FunctionDef":
            return

        raise Exception(
            f"未対応のASTノード: {typ}"
        )

    def execute_block(self, body, env):
        i = 0

        while i < len(body):
            self._consume_step()
            node = body[i]
            typ = node.get("type")

            # if / elif / else は同じチェーンとして処理する。
            if typ == "IfStatement":
                matched = False

                if self.eval_expr(node["condition"], env):
                    self.execute_block(node.get("body", []), env)
                    matched = True

                i += 1

                while i < len(body) and body[i].get("type") in (
                    "ElifStatement", "ElseStatement"
                ):
                    branch = body[i]
                    branch_type = branch.get("type")

                    if (
                        not matched
                        and branch_type == "ElifStatement"
                        and self.eval_expr(branch["condition"], env)
                    ):
                        self.execute_block(branch.get("body", []), env)
                        matched = True

                    elif (
                        not matched
                        and branch_type == "ElseStatement"
                    ):
                        self.execute_block(branch.get("body", []), env)
                        matched = True

                    i += 1

                continue

            # elif / else が単独で来た場合も安全に実行する。
            if typ == "ElifStatement":
                if self.eval_expr(node["condition"], env):
                    self.execute_block(node.get("body", []), env)
                i += 1
                continue

            if typ == "ElseStatement":
                self.execute_block(node.get("body", []), env)
                i += 1
                continue

            self.execute_node(node, env)
            i += 1

    def run(self):
        self._begin_execution()
        try:
            self.execute_block(
                self.tree.get("body", []),
                self.globals
            )
            return "\n".join(self.output)
        finally:
            self._end_execution()


# ====================================================
# Discord feature detection
# ====================================================

DISCORD_FUNCTIONS = {
    "discord_start",
    "discord_stop",
    "discord_status",
    "discord_send",
    "discord_on",
    "discord_reply",
    "discord_content",
    "discord_channel_id",
    "discord_message_id",
    "discord_author_id",
    "discord_guild_id",
    "discord_event"
}


def contains_discord_features(tree):
    def walk(node):
        if isinstance(node, dict):
            if (
                node.get("type") == "CallExpr"
                and node.get("name")
                in DISCORD_FUNCTIONS
            ):
                return True

            return any(
                walk(value)
                for value in node.values()
            )

        if isinstance(node, list):
            return any(
                walk(value)
                for value in node
            )

        return False

    return walk(tree)


# ====================================================
# PStudio Game Engine: source -> validated AST
# ====================================================

@app.route("/game/prepare", methods=["POST"])
def game_prepare():
    """Parse game scripts for the isolated browser runtime; never executes user code here."""
    data = request.get_json(silent=True) or {}
    scripts = data.get("scripts", {})
    if not isinstance(scripts, dict) or not scripts:
        return jsonify({"success": False, "error": "scripts は ps ファイル名とソースの辞書で指定してください。"}), 400
    if len(scripts) > 32:
        return jsonify({"success": False, "error": "1シーンで読み込めるスクリプトは最大32個です。"}), 400

    parsed = {}
    total_size = 0
    try:
        for filename, source in scripts.items():
            if not isinstance(filename, str) or not filename.endswith(".ps"):
                raise Exception("スクリプト名は .ps ファイルにしてください。")
            if not isinstance(source, str):
                raise Exception(f"{filename}: ソースコードは文字列で指定してください。")
            total_size += len(source.encode("utf-8"))
            if total_size > 512 * 1024:
                raise Exception("ゲームスクリプト全体の上限は512KBです。")
            tree = parse(tokenize(source))
            parsed[filename] = tree

        project_components = {}
        for filename, tree in parsed.items():
            for node in tree.get("body", []):
                if node.get("type") != "ComponentDef":
                    continue
                name = node["name"]
                if name in project_components:
                    raise Exception(f"Component '{name}' が複数の .ps ファイルで定義されています。")
                project_components[name] = {
                    field["variable"]: field["value"]
                    for field in node.get("body", [])
                    if field.get("type") == "AssignmentExpression"
                }
        for filename, tree in parsed.items():
            local_names = {
                node["name"] for node in tree.get("body", [])
                if node.get("type") == "ComponentDef"
            }
            external = {
                name: fields for name, fields in project_components.items()
                if name not in local_names
            }
            validate_ast(tree, allow_game=True, external_components=external)
        return jsonify({"success": True, "scripts": parsed, "engine": "PStudio Runtime", "engine_version": "3.0.0"})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


# ====================================================
# /compile
# ====================================================

@app.route("/native/ecs/export", methods=["POST"])
def native_ecs_export():
    """Export validated ps ECS declarations as a portable C++17/CMake source package."""
    data = request.get_json(silent=True) or {}
    scripts = data.get("scripts", {})
    if not isinstance(scripts, dict) or not scripts:
        return jsonify({"success": False, "error": "scripts は .ps ファイル名とソースの辞書で指定してください。"}), 400
    if len(scripts) > 32:
        return jsonify({"success": False, "error": "プロジェクト内の .ps ファイルは最大32個です。"}), 400

    parsed = {}
    total_size = 0
    try:
        for filename, source in scripts.items():
            if not isinstance(filename, str) or not filename.endswith(".ps"):
                raise Exception("スクリプト名は .ps ファイルにしてください。")
            if not isinstance(source, str):
                raise Exception(f"{filename}: ソースコードは文字列で指定してください。")
            total_size += len(source.encode("utf-8"))
            if total_size > 512 * 1024:
                raise Exception("ゲームスクリプト全体の上限は512KBです。")
            parsed[filename] = parse(tokenize(source))

        project_components = {}
        for filename, tree in parsed.items():
            for node in tree.get("body", []):
                if node.get("type") != "ComponentDef":
                    continue
                name = node["name"]
                if name in project_components:
                    raise Exception(f"Component '{name}' が複数の .ps ファイルで定義されています。")
                project_components[name] = {
                    field["variable"]: field["value"]
                    for field in node.get("body", [])
                    if field.get("type") == "AssignmentExpression"
                }

        for filename, tree in parsed.items():
            local_names = {
                node["name"] for node in tree.get("body", [])
                if node.get("type") == "ComponentDef"
            }
            external = {
                name: fields for name, fields in project_components.items()
                if name not in local_names
            }
            validate_ast(tree, allow_game=True, external_components=external)

        generated = generate_native_ecs_sources(parsed)
        header_path = os.path.join(os.path.dirname(__file__), "native", "include", "pstudio", "ecs.hpp")
        with open(header_path, "r", encoding="utf-8") as header_file:
            generated["native/include/pstudio/ecs.hpp"] = header_file.read()

        archive = io.BytesIO()
        with zipfile.ZipFile(archive, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
            for name, content in generated.items():
                package.writestr(name, content)
        archive.seek(0)
        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name="pstudio-native-ecs-cmake.zip"
        )
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


@app.route("/compile", methods=["POST"])
def compile_code():
    data = request.get_json(silent=True) or {}
    source = data.get("code", "")
    if not isinstance(source, str):
        return jsonify({"success": False, "error": "code は文字列で指定してください。"}), 400
    if not source.strip():
        return jsonify({"success": False, "error": "コードが空です。"}), 400
    if source_size_bytes(source) > MAX_PS_SOURCE_BYTES:
        return jsonify({
            "success": False,
            "error": "ソースコードの上限は512KBです。"
        }), 413
    try:
        tree = parse(tokenize(source))
        validate_ast(tree)
        if contains_discord_features(tree):
            return jsonify({"success": False, "error": "Discordイベント機能は通常のC++17コンパイル対象ではありません。/run のps Runtimeで実行してください。"}), 400
        return jsonify({"success": True, "cpp": generate_cpp(tree), "mode": "cpp17"})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400


# ====================================================
# /run
# ====================================================

@app.route("/run", methods=["POST"])
@limit_ps_run_concurrency
def run_code():
    data = request.get_json(
        silent=True
    ) or {}

    source = data.get(
        "code",
        ""
    )
    stdin_text = data.get("stdin", "")
    if not isinstance(stdin_text, str):
        return jsonify({"success": False, "error": "stdin は文字列で指定してください。"}), 400

    if not isinstance(source, str):
        return jsonify({
            "success": False,
            "error": "code は文字列で指定してください。"
        }), 400

    if not source.strip():
        return jsonify({
            "success": False,
            "error": "コードが空です。"
        }), 400

    if source_size_bytes(source) > MAX_PS_SOURCE_BYTES:
        return jsonify({
            "success": False,
            "error": "ソースコードの上限は512KBです。"
        }), 413

    if source_size_bytes(stdin_text) > MAX_PS_STDIN_BYTES:
        return jsonify({
            "success": False,
            "error": "標準入力の上限は128KBです。"
        }), 413

    try:
        tokens = tokenize(source)

        tree = parse(tokens)

        # C++ backend と ps Runtime の両方で共通する意味検査を行う。
        validate_ast(tree)

        if contains_discord_features(tree):
            if not PS_DISCORD_AVAILABLE:
                return jsonify({
                    "success": False,
                    "error": (
                        "discord_runtime.py "
                        "が利用できません。"
                    )
                }), 500

            interpreter = PsDiscordInterpreter(
                tree
            )

            output = interpreter.run()

            return jsonify({
                "success": True,
                "output": output,
                "mode": "ps"
            })

        cpp_code = generate_cpp(tree)

        # リクエストごとに専用ディレクトリを使う。
        # 同時実行時に main.cpp / main が競合しないようにする。
        with tempfile.TemporaryDirectory(prefix="ps_") as workdir:
            source_path = os.path.join(workdir, "main.cpp")
            executable_path = os.path.join(workdir, "main")

            with open(
                source_path,
                "w",
                encoding="utf-8"
            ) as f:
                f.write(cpp_code)

            compile_result = run_process_bounded(
                [
                    "g++",
                    "-std=c++17",
                    source_path,
                    "-o",
                    executable_path
                ],
                timeout=30
            )

            if compile_result.returncode != 0:
                return jsonify({
                    "success": False,
                    "error": compile_result.stderr,
                    "cpp": cpp_code
                })

            run_result = run_process_bounded(
                [executable_path],
                input_text=stdin_text,
                timeout=30
            )

            return jsonify({
                "success": run_result.returncode == 0,
                "output": run_result.stdout,
                "error": run_result.stderr,
                "cpp": cpp_code,
                "mode": "cpp"
            })

    except subprocess.TimeoutExpired:
        return jsonify({
            "success": False,
            "error": "実行がタイムアウトしました。"
        }), 408

    except ProcessOutputLimitExceeded as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 422

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 400


# ====================================================
# REST Discord API
# ====================================================

@app.route("/discord/status", methods=["GET"])
def discord_status():
    bot = get_discord_bot()

    if bot is None:
        return jsonify({
            "running": False
        })

    return jsonify({
        "running": True
    })


@app.route("/discord/start", methods=["POST"])
def discord_start():
    if not PS_DISCORD_AVAILABLE:
        return jsonify({
            "success": False,
            "error": "discord_runtime.py が利用できません。"
        }), 500

    data = request.get_json(
        silent=True
    ) or {}

    token = data.get(
        "token",
        ""
    )

    if not token:
        return jsonify({
            "success": False,
            "error": "Bot Tokenが必要です。"
        }), 400

    existing = get_discord_bot()

    if existing is not None:
        return jsonify({
            "success": True,
            "message": "Discord Botはすでに起動しています。",
            "reused": True
        })

    try:
        bot = DiscordBot(
            str(token)
        )

        set_discord_bot(bot)

        def runner():
            try:
                bot.start(
                    background=False
                )

            except Exception as e:
                print(
                    f"[REST Discord] {e}"
                )

            finally:
                current = get_discord_bot()

                if current is bot:
                    set_discord_bot(None)

        threading.Thread(
            target=runner,
            daemon=True
        ).start()

        return jsonify({
            "success": True,
            "message": "Discord Botを起動しました。",
            "reused": False
        })

    except Exception as e:
        set_discord_bot(None)

        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route("/discord/stop", methods=["POST"])
def discord_stop():
    bot = get_discord_bot()

    if bot is None:
        return jsonify({
            "success": True,
            "message": "Discord Botは起動していません。"
        })

    try:
        bot.stop()

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

    finally:
        set_discord_bot(None)

    return jsonify({
        "success": True,
        "message": "Discord Botを停止しました。"
    })


@app.route("/discord/send", methods=["POST"])
def discord_send():
    bot = get_discord_bot()

    if bot is None:
        return jsonify({
            "success": False,
            "error": "Discord Botが起動していません。"
        }), 400

    data = request.get_json(
        silent=True
    ) or {}

    channel_id = data.get(
        "channel_id"
    )

    content = data.get(
        "content"
    )

    if channel_id is None:
        return jsonify({
            "success": False,
            "error": "channel_id が必要です。"
        }), 400

    if content is None:
        return jsonify({
            "success": False,
            "error": "content が必要です。"
        }), 400

    if len(str(content)) > MAX_DISCORD_CONTENT_CHARS:
        return jsonify({
            "success": False,
            "error": "Discordメッセージは2000文字以内にしてください。"
        }), 400

    try:
        bot.send_message(
            str(channel_id),
            str(content)
        )

        return jsonify({
            "success": True
        })

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ====================================================
# Startup
# ====================================================

if __name__ == "__main__":
    port = int(
        os.environ.get(
            "PORT",
            5000
        )
    )

    app.run(
        host="0.0.0.0",
        port=port
    )
