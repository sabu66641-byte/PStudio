const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const locales = ['ja', 'en', 'zh', 'es', 'fr', 'ko'];

function sectionBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.notEqual(from, -1, start + ' must exist');
  assert.notEqual(to, -1, end + ' must exist');
  return html.slice(from, to);
}

test('all six header language options use the shared click handler', () => {
  for (const locale of locales) {
    assert.match(html, new RegExp('data-language="' + locale + '"'));
    assert.ok(!html.includes(`onclick="chooseLanguage('${locale}')"`), locale + ' must not have a duplicate inline click handler');
  }
  assert.match(html, /menu\.addEventListener\("click"/);
  assert.match(html, /setLanguage\(option\.dataset\.language\)/);
});

test('the saved locale is restored and Japanese is initialized on first visit', () => {
  assert.match(
    html,
    /setLanguage\(\["ja", "en", "zh", "es", "fr", "ko"\]\.includes\(savedLanguage\) \? savedLanguage : "ja"\)/
  );
  assert.match(html, /document\.documentElement\.lang = language === "zh" \? "zh-Hans" : language/);
});

test('Korean locale includes workspace labels, runtime messages and page metadata', () => {
  assert.match(html,/ko:\s*"한국어"/);
  assert.match(html,/"ko":\s*\{/);
  for (const label of ['"PROJECT":"프로젝트"','"INSPECTOR":"인스펙터"','"ULTRA QUALITY":"최고 화질"','"Run":"실행"']) {
    assert.ok(html.includes(label),label);
  }
  assert.match(html,/ko:\s*"PStudio — ps 개발 환경"/);
  assert.match(html,/ko:\s*\{\s*empty:/);
  assert.match(html,/language === "zh" \? "zh-Hans" : language/);
});
test('all six locales provide the three PS overview paragraphs', () => {
  const about = sectionBetween('const aboutTranslations =', 'const runtimeMessages');
  for (const locale of locales) {
    assert.match(about, new RegExp('"' + locale + '"\\s*:\\s*\\{'));
    for (const key of ['intro', 'goal', 'vision']) {
      assert.match(about, new RegExp('"' + key + '"\\s*:'));
    }
  }
  for (const id of ['about-intro', 'about-goal', 'about-vision']) {
    const match = html.match(new RegExp('<p id="' + id + '" class="about-localized">([\\s\\S]*?)</p>'));
    assert.ok(match && match[1].trim().length > 40, id + ' must have a non-empty Japanese fallback');
  }
});

test('translated about paragraphs are excluded from dynamic text rebasing', () => {
  assert.match(html, /parent\.closest\("\.about-localized/);
  assert.match(html, /!node\.parentElement\?\.closest\("\.about-localized"\)/);
  assert.match(html, /element\.textContent = about\[key\]/);
});

test('translation keeps canonical source text and correct whitespace boundaries', () => {
  assert.match(html, /if \(!originalTextNodes\.has\(node\)\)/);
  assert.match(html, /originalTextNodes\.set\(node, current\)/);
  assert.match(html, /original\.match\(\/\\s\*\$\/\)\[0\]/);
});

test('responsive layout changes do not override the existing font sizes', () => {
  const css = sectionBetween('/* Responsive UI refinement', '</style>');
  assert.doesNotMatch(css, /font-size\s*:/);
});

test('runtime text updates are translated without replacing the canonical source', () => {
  assert.match(html, /const appliedTextNodes = new WeakMap\(\)/);
  assert.match(html, /record\.type === "characterData"/);
  assert.match(html, /current !== lastApplied/);
  assert.match(html, /originalTextNodes\.set\(node, current\)/);
  assert.match(html, /characterData: true/);
});
