import { useTranslate } from '../../i18n/index.js'
import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
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
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

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
  const [showDiagram, setShowDiagram] = useState(true)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  const FOLD_LINES = 5
  const preRef = useRef<HTMLPreElement>(null)
  const [collapsed, setCollapsed] = useState(true)
  const [needsFold, setNeedsFold] = useState(false)
  useEffect(() => {
    if (lang === null || loaded) {
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
  }, [lang, loaded, rerender])
  const name = lang !== null && loaded ? lang : 'plaintext'
  const renderedHtml = useMemo(() => {
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, name])

  useLayoutEffect(() => {
    const pre = preRef.current
    if (!pre || isMermaid) {
      setNeedsFold(false)
      return
    }
    const lineHeight = parseFloat(getComputedStyle(pre).lineHeight) || 20
    const threshold = lineHeight * FOLD_LINES
    setNeedsFold(pre.scrollHeight > threshold + lineHeight * 0.5)
  }, [code, name, loaded, isMermaid])

  return (
    <div className={clsx('md-code-block', needsFold && collapsed && 'is-collapsed')}>
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
            ref={preRef}
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
