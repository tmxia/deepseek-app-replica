import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useMemo, useReducer, useState } from 'react'
import clsx from 'clsx'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconCopyOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { useInView } from '../../utils/useInView.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 代码块标题栏：左侧语言名，右侧复制 */
const CodeInfoRow = ({
  code,
  infostring,
  showDiagram,
  onToggleDiagram,
}: {
  code: string
  infostring: string
  showDiagram: boolean
  onToggleDiagram?: () => void
}) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.container}>
      {onToggleDiagram ? (
        <div className="md-code-block-switch" aria-label={t('mermaidSwitchLabel')}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showDiagram}
            onClick={() => !showDiagram && onToggleDiagram()}
          >
            {t('mermaidDiagram')}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={!showDiagram}
            onClick={() => showDiagram && onToggleDiagram()}
          >
            {t('mermaidCode')}
          </button>
        </div>
      ) : (
        <span className={styles.name}>{infostring}</span>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={async () => {
          if (!(await copyText(code))) {
            showToast({ key: 'copyFailed' })
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        <span>{t(copied ? 'copied' : 'copy')}</span>
      </button>
    </div>
  )
}

/** 代码块：语言包按需加载，不支持或尚未加载的语言按纯文本显示 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
}: {
  code: string
  infostring: string
  loading?: boolean
}) {
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  const t = useTranslate()
  const { ref, inView } = useInView<HTMLDivElement>()
  const [showDiagram, setShowDiagram] = useState(true)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  const FOLD_LINES = 5
  const [collapsed, setCollapsed] = useState(true)
  // 按逻辑行判定是否折叠：pre-wrap 下长行折行、上下 padding 都会撑高 scrollHeight，
  // 用视觉高度会把不足行数的短块误判为需要折叠；不足阈值时不渲染折叠按钮。
  const codeLineCount = code.trim().split('\n').length
  const needsFold = !isMermaid && codeLineCount > FOLD_LINES
  useEffect(() => {
    if (!inView || lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender, inView])
  const name = lang !== null && loaded ? lang : 'plaintext'
  const renderedHtml = useMemo(() => {
    // 未进入视口时先渲染纯文本，不触发 Prism 分词着色与语言包加载。
    if (!inView) {
      return escapeHtml(code)
    }
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, name, inView])

  return (
    <div ref={ref} className={clsx('md-code-block', needsFold && collapsed && 'is-collapsed')}>
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          showDiagram={showDiagram}
          onToggleDiagram={isMermaid ? () => setShowDiagram((show) => !show) : undefined}
        />
      </div>
      {isMermaid && showDiagram ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : (
        <>
          <pre
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
            data-lang={name}
          ></pre>
          {needsFold ? (
            <button
              type="button"
              className={styles.foldToggle}
              onClick={() => setCollapsed((show) => !show)}
            >
              {collapsed ? t('expandCode') : t('collapseCode')}
              <span className={clsx(styles.foldIcon, !collapsed && styles.foldIconUp)}>
                <IconChevronDownOutline14 />
              </span>
            </button>
          ) : null}
        </>
      )}
    </div>
  )
})
