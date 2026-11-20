const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const locales = ['ja', 'en', 'zh', 'es', 'fr'];

function sectionBetween(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.notEqual(from, -1, start + ' must exist');
  assert.notEqual(to, -1, end + ' must exist');
  return html.slice(from, to);
}

test('all five header language options use the shared click handler', () => {
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
    /setLanguage\(\["ja", "en", "zh", "es", "fr"\]\.includes\(savedLanguage\) \? savedLanguage : "ja"\)/
  );
  assert.match(html, /document\.documentElement\.lang = language === "zh" \? "zh-Hans" : language/);
});

test('all five locales provide the three PS overview paragraphs', () => {
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
  assert.match(html, /if \(!originalTextNodes\.has\(node\)\) originalTextNodes\.set\(node, current\)/);
  assert.match(html, /original\.match\(\/\^\\s\*\/\)\[0\]/);
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
