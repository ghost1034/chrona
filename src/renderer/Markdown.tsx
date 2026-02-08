import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'

function sanitizeHref(hrefRaw: unknown): string | null {
  const href = typeof hrefRaw === 'string' ? hrefRaw.trim() : ''
  if (!href) return null

  // Only allow explicit external links.
  // (No relative URLs, no file://, no javascript:, etc.)
  try {
    const u = new URL(href)
    const p = u.protocol.toLowerCase()
    if (p === 'http:' || p === 'https:' || p === 'mailto:') return href
    return null
  } catch {
    return null
  }
}

export function Markdown(props: { text: string; className?: string }) {
  const text = String(props.text ?? '')

  return (
    <div className={props.className ?? 'md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }: { href?: string; children?: ReactNode }) => {
            const safe = sanitizeHref(href)
            if (!safe) return <span className="md-linkBlocked">{children}</span>
            return (
              <a href={safe} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            )
          },
          img: ({ alt }: { alt?: string }) => {
            const label = alt ? `Image: ${alt}` : 'Image'
            return <span className="md-imgBlocked">[{label} omitted]</span>
          },
          table: ({ children }: { children?: ReactNode }) => (
            <div className="md-tableWrap">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
