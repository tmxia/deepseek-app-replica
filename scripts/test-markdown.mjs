import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toMdAst } from '../src/services/markdown/parse.ts'

const parse = (lines, newline = '\n') =>
  toMdAst(lines.join(newline), { sources: undefined, disableLink: false }).children

test('列表中的公式续行退回正文时补齐缩进，并保留公式后的段落', () => {
  const limit = String.raw`\lim_{n \to \infty} \left| \frac{a_n}{a_{n-1}} \right| = 1`
  for (const newline of ['\n', '\r\n']) {
    const [list, after] = parse(
      ['1. First', '2. Limit', '   Compute the ratio.', '', '   \\[', limit, '\\]', 'After.'],
      newline
    )
    const formula = list.children[1].children[1]
    assert.equal(formula.type, 'math')
    assert.equal(formula.value, limit)
    assert.equal(after.type, 'paragraph')
    assert.equal(after.children[0].value, 'After.')
  }
})

test('嵌套列表内的公式与下一列表项各自独立', () => {
  const [list] = parse(['1. First', '   - Nested', '     \\[', 'x + 1', '\\]', '2. Next'])
  const nested = list.children[0].children[1]
  const formula = nested.children[0].children[1]
  assert.equal(formula.type, 'math')
  assert.equal(formula.value, 'x + 1')
  assert.equal(list.children[1].children[0].children[0].value, 'Next')
})

test('合法公式、围栏代码与未闭合公式保留各自的 Markdown 语义', () => {
  const [normal, inline] = parse(['1. Limit', '   \\[', '   x', '   \\]', '', '`\\[a\\]`'])
  assert.equal(normal.children[0].children[1].value, 'x')
  assert.equal(inline.children[0].type, 'inlineCode')
  assert.equal(inline.children[0].value, '\\[a\\]')

  const [list, code] = parse(['1. Limit', '   \\[', '```text', '\\frac{a}{b}', '\\]', '```'])
  assert.equal(list.children[0].children[1].value, '')
  assert.equal(code.type, 'code')
  assert.equal(code.value, '\\frac{a}{b}\n\\]')

  const [unfinished, prose] = parse(['1. Limit', '   \\[', 'Outside the list.'])
  assert.equal(unfinished.children[0].children[1].value, '')
  assert.equal(prose.children[0].value, 'Outside the list.')
})
