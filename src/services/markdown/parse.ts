import type { List, Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Source } from '../chat/view.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

export type MarkdownParseOptions = { sources: Source[] | undefined; disableLink: boolean }

const parserOptions = {
  extensions: [
    // codeIndented 语法导致有前导空格的列表无法正常渲染
    { ...gfm(), disable: { null: ['codeIndented'] } },
    math({ singleDollarTextMath: true }),
  ],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
}

// 模型有时只缩进列表内的公式起始行，导致 micromark 把后续行解析到列表外。
// 仅修复紧接列表的段落中有闭合定界符的情况，且只在渲染时补齐这几行的缩进。
function indentListMath(input: string, ast: Root): string {
  const parts: string[] = []
  let cursor = 0

  const visit = (parent: Root | Parent) => {
    for (const [index, node] of parent.children.entries()) {
      if (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote') {
        visit(node)
      }
      const next = parent.children[index + 1]
      if (node.type !== 'list' || next?.type !== 'paragraph') {
        continue
      }

      let list: List = node
      let tail: List['children'][number]['children'][number] | undefined
      do {
        const item = list.children[list.children.length - 1]
        tail = item?.children[item.children.length - 1]
        if (tail?.type === 'list') {
          list = tail
        }
      } while (tail?.type === 'list')
      if (tail?.type !== 'math') {
        continue
      }

      const open = tail.position?.start
      const mathEnd = tail.position?.end.offset
      const paragraphStart = next.position?.start
      if (
        open?.offset === undefined ||
        mathEnd === undefined ||
        paragraphStart?.offset === undefined
      ) {
        continue
      }
      const mathSource = input.slice(open.offset, mathEnd)
      if (!/^\\\[[ \t]*(?:\r|\n|$)/.test(mathSource) || mathSource.trimEnd().endsWith('\\]')) {
        continue
      }
      if (!/^[ \t]*(?:\r\n?|\n) *$/.test(input.slice(mathEnd, paragraphStart.offset))) {
        continue
      }

      const closing = /^ *\\\][ \t]*(?=\r|\n|$)/m.exec(
        input.slice(paragraphStart.offset, next.position?.end.offset)
      )
      if (!closing) {
        continue
      }

      const start = paragraphStart.offset - paragraphStart.column + 1
      const end = paragraphStart.offset + closing.index + closing[0].length
      const indented = input
        .slice(start, end)
        .replace(/^ *(?=\S)/gm, (prefix) => prefix.padEnd(open.column - 1))
      parts.push(input.slice(cursor, start), indented)
      cursor = end
    }
  }

  visit(ast)
  return cursor === 0 ? input : parts.join('') + input.slice(cursor)
}

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(input: string, { sources, disableLink }: MarkdownParseOptions): Root {
  let ast = fromMarkdown(input, parserOptions)
  if (input.includes('\\[')) {
    const indented = indentListMath(input, ast)
    if (indented !== input) {
      input = indented
      ast = fromMarkdown(input, parserOptions)
    }
  }
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        /\[citation:(\d+)\]/g,
        (_: string, index: string): CitationNode | '' => {
          const source = sourcesByIndex.get(Number(index))
          return source ? { type: 'citation', source } : ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? node.children : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  return ast
}
