"""
PStudio Network Runtime
HTTP / HTTPS / JSON / Headers / Async

既存psコードとの互換性を重視した通信ランタイム。
標準ライブラリのみで動作します。
"""

import asyncio
import json
import math
import socket
import urllib.error
import urllib.request
from collections.abc import Mapping
from urllib.parse import urlencode, urlsplit, urlunsplit


DEFAULT_TIMEOUT = 10
DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
ERROR_BODY_LIMIT = 4096
USER_AGENT = "PStudio-Network/1.0"


class NetworkError(Exception):
    """psの通信エラー。status / body / url を追加情報として保持します。"""

    def __init__(self, message, status=None, body=None, url=None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.url = url


def _validate_timeout(timeout):
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise NetworkError("timeoutは正の数値で指定してください。")
    if not math.isfinite(timeout) or timeout <= 0:
        raise NetworkError("timeoutは0より大きい有限の数値で指定してください。")
    return float(timeout)


def _validate_max_response_bytes(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise NetworkError("max_response_bytesは1以上の整数で指定してください。")
    return value


def _validate_url(url):
    if not isinstance(url, str) or not url.strip():
        raise NetworkError("URLが空か、文字列ではありません。")
    url = url.strip()
    try:
        parts = urlsplit(url)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            raise NetworkError("URLには http:// または https:// の完全なURLを指定してください。")
        if parts.username is not None or parts.password is not None:
            raise NetworkError("URLへのユーザー名・パスワード埋め込みはサポートしていません。")
        # 不正なポート番号もここで検出
        _ = parts.port
    except ValueError as exc:
        raise NetworkError(f"URLの形式が不正です: {exc}") from exc
    return url


def _merge_params(url, params):
    if params is None:
        return url
    if not isinstance(params, Mapping):
        raise NetworkError("paramsはdict形式で指定してください。")
    try:
        encoded = urlencode(params, doseq=True)
        if not encoded:
            return url
        parts = urlsplit(url)
        query = f"{parts.query}&{encoded}" if parts.query else encoded
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))
    except (TypeError, ValueError) as exc:
        raise NetworkError(f"URLパラメータの変換に失敗しました: {exc}") from exc


def _copy_headers(headers):
    if headers is None:
        return {}
    if not isinstance(headers, Mapping):
        raise NetworkError("headersはdict形式で指定してください。")
    copied = {}
    for key, value in headers.items():
        if not isinstance(key, str) or not isinstance(value, (str, int, float)):
            raise NetworkError("HTTPヘッダーの名前と値は文字列または数値で指定してください。")
        copied[key] = str(value)
    return copied


def _has_header(headers, name):
    return any(key.lower() == name.lower() for key in headers)


def _encode_body(data, headers):
    if data is None:
        return None

    if isinstance(data, Mapping) or isinstance(data, (list, tuple)):
        try:
            body = json.dumps(
                data, ensure_ascii=False, allow_nan=False,
                separators=(",", ":")
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise NetworkError(f"JSON変換エラー: {exc}") from exc
        if not _has_header(headers, "Content-Type"):
            headers["Content-Type"] = "application/json; charset=utf-8"
        return body

    if isinstance(data, str):
        return data.encode("utf-8")
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)

    raise NetworkError("送信データはdict/list/tuple/string/bytes形式で指定してください。")


def parse_json(text):
    """JSON文字列をPythonデータに変換します。JSONでなければNoneを返します。"""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def json_string(data):
    """PythonデータをUTF-8互換のJSON文字列に変換します。"""
    try:
        return json.dumps(data, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise NetworkError(f"JSON変換エラー: {exc}") from exc


def _decode_response(raw, headers):
    charset = None
    try:
        charset = headers.get_content_charset()
    except (AttributeError, TypeError):
        pass
    try:
        return raw.decode(charset or "utf-8")
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


def http_request(
    url,
    method="GET",
    data=None,
    headers=None,
    timeout=DEFAULT_TIMEOUT,
    params=None,
    max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES
):
    """
    HTTP / HTTPSリクエスト。

    戻り値:
      {
        "status": HTTPステータス,
        "ok": 2xxかどうか,
        "headers": レスポンスヘッダー,
        "text": 本文,
        "data": JSON解析結果（JSONでなければNone）,
        "url": 最終URL
      }

    HTTPエラー・通信エラーはNetworkErrorとして通知します。
    """
    url = _validate_url(url)
    timeout = _validate_timeout(timeout)
    max_response_bytes = _validate_max_response_bytes(max_response_bytes)

    if not isinstance(method, str) or not method.strip():
        raise NetworkError("HTTPメソッドが不正です。")
    method = method.strip().upper()
    if not method.isascii() or not method.replace("-", "").isalpha():
        raise NetworkError("HTTPメソッドの形式が不正です。")

    request_headers = _copy_headers(headers)
    body = _encode_body(data, request_headers)
    request_url = _merge_params(url, params)

    if not _has_header(request_headers, "User-Agent"):
        request_headers["User-Agent"] = USER_AGENT
    request = urllib.request.Request(
        url=request_url,
        data=body,
        headers=request_headers,
        method=method
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(max_response_bytes + 1)
            if len(raw) > max_response_bytes:
                raise NetworkError(
                    f"レスポンスが上限（{max_response_bytes} bytes）を超えました。",
                    status=response.status,
                    url=response.geturl()
                )
            response_headers = response.headers
            text = _decode_response(raw, response_headers)
            status = response.status
            return {
                "status": status,
                "ok": 200 <= status < 300,
                "headers": dict(response_headers.items()),
                "text": text,
                "data": parse_json(text),
                "url": response.geturl()
            }

    except urllib.error.HTTPError as exc:
        try:
            raw_error = exc.read(ERROR_BODY_LIMIT + 1)
            body_text = raw_error[:ERROR_BODY_LIMIT].decode("utf-8", errors="replace")
            if len(raw_error) > ERROR_BODY_LIMIT:
                body_text += "…（エラー本文を省略）"
        except Exception:
            body_text = ""
        raise NetworkError(
            f"HTTPエラー {exc.code}: {body_text}",
            status=exc.code,
            body=body_text,
            url=request_url
        ) from exc
    except NetworkError:
        raise
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        raise NetworkError(f"通信エラー: {reason}", url=request_url) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise NetworkError("通信がタイムアウトしました。", url=request_url) from exc
    except (ValueError, TypeError) as exc:
        raise NetworkError(f"リクエストの形式が不正です: {exc}", url=request_url) from exc
    except Exception as exc:
        raise NetworkError(f"通信中にエラーが発生しました: {exc}", url=request_url) from exc


def request(url, method="GET", data=None, headers=None, timeout=DEFAULT_TIMEOUT,
            params=None, max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    """http_requestの短い別名。"""
    return http_request(url, method, data, headers, timeout, params, max_response_bytes)


def get(url, headers=None, params=None, timeout=DEFAULT_TIMEOUT,
        max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return http_request(url, "GET", headers=headers, timeout=timeout,
                        params=params, max_response_bytes=max_response_bytes)


def post(url, data=None, headers=None, timeout=DEFAULT_TIMEOUT,
         max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return http_request(url, "POST", data, headers, timeout,
                        max_response_bytes=max_response_bytes)


def put(url, data=None, headers=None, timeout=DEFAULT_TIMEOUT,
        max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return http_request(url, "PUT", data, headers, timeout,
                        max_response_bytes=max_response_bytes)


def patch(url, data=None, headers=None, timeout=DEFAULT_TIMEOUT,
          max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return http_request(url, "PATCH", data, headers, timeout,
                        max_response_bytes=max_response_bytes)


def delete(url, headers=None, timeout=DEFAULT_TIMEOUT,
           max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return http_request(url, "DELETE", headers=headers, timeout=timeout,
                        max_response_bytes=max_response_bytes)


def head(url, headers=None, params=None, timeout=DEFAULT_TIMEOUT):
    """レスポンス本文を取得しないHEADリクエスト。"""
    return http_request(url, "HEAD", headers=headers, timeout=timeout, params=params)


def options(url, headers=None, timeout=DEFAULT_TIMEOUT):
    """OPTIONSリクエスト。"""
    return http_request(url, "OPTIONS", headers=headers, timeout=timeout)


async def async_request(url, method="GET", data=None, headers=None,
                        timeout=DEFAULT_TIMEOUT, params=None,
                        max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    """ブロッキングHTTP処理を別スレッドで実行する非同期リクエスト。"""
    return await asyncio.to_thread(
        http_request, url, method, data, headers, timeout, params, max_response_bytes
    )


async def async_get(url, headers=None, params=None, timeout=DEFAULT_TIMEOUT,
                    max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return await async_request(url, "GET", headers=headers, timeout=timeout,
                               params=params, max_response_bytes=max_response_bytes)


async def async_post(url, data=None, headers=None, timeout=DEFAULT_TIMEOUT,
                     max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return await async_request(url, "POST", data, headers, timeout,
                               max_response_bytes=max_response_bytes)


async def async_put(url, data=None, headers=None, timeout=DEFAULT_TIMEOUT,
                    max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return await async_request(url, "PUT", data, headers, timeout,
                               max_response_bytes=max_response_bytes)


async def async_patch(url, data=None, headers=None, timeout=DEFAULT_TIMEOUT,
                      max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return await async_request(url, "PATCH", data, headers, timeout,
                               max_response_bytes=max_response_bytes)


async def async_delete(url, headers=None, timeout=DEFAULT_TIMEOUT,
                       max_response_bytes=DEFAULT_MAX_RESPONSE_BYTES):
    return await async_request(url, "DELETE", headers=headers, timeout=timeout,
                               max_response_bytes=max_response_bytes)


async def async_head(url, headers=None, params=None, timeout=DEFAULT_TIMEOUT):
    return await async_request(url, "HEAD", headers=headers, timeout=timeout, params=params)


def json_headers(extra=None):
    """JSON通信向けの基本ヘッダーを作成します。"""
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": USER_AGENT
    }
    headers.update(_copy_headers(extra))
    return headers


def bearer_headers(token, extra=None):
    """Bearer認証用ヘッダーを作成します。"""
    if not isinstance(token, str) or not token.strip():
        raise NetworkError("Bearer tokenが空か、不正です。")
    headers = {"Authorization": f"Bearer {token.strip()}"}
    headers.update(_copy_headers(extra))
    return headers


__all__ = [
    "NetworkError", "http_request", "request",
    "get", "post", "put", "patch", "delete", "head", "options",
    "parse_json", "json_string",
    "async_request", "async_get", "async_post", "async_put",
    "async_patch", "async_delete", "async_head",
    "json_headers", "bearer_headers",
]
