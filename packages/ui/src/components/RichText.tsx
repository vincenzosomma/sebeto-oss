/**
 * Chat text with Markdown: code blocks become code panes (language label, colours, Copy button),
 * plus `inline code`, lists, tables, bold and links.
 *
 * Safety: react-markdown never renders raw HTML from the text (no rehype-raw), and highlight.js
 * escapes the code it colours, so agent output (which may quote emails or web pages) cannot
 * inject markup or scripts. Links open outside the app.
 */
import { memo, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import hljs from 'highlight.js/lib/core';
import powershell from 'highlight.js/lib/languages/powershell';
import bash from 'highlight.js/lib/languages/bash';
import dos from 'highlight.js/lib/languages/dos';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import ini from 'highlight.js/lib/languages/ini';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { useI18n } from '../i18n/I18nProvider';

// IT Ops languages only, to keep the app small. Aliases cover what agents usually write.
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('dos', dos);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerAliases(['ps', 'ps1', 'pwsh'], { languageName: 'powershell' });
hljs.registerAliases(['cmd', 'bat', 'batch'], { languageName: 'dos' });
hljs.registerAliases(['shell', 'console'], { languageName: 'bash' });
hljs.registerAliases(['text', 'txt', 'output', 'log'], { languageName: 'plaintext' });

/** Display name for the pane header. Exported for tests. */
export function languageLabel(lang: string | null): string {
  if (!lang) return '';
  const def = hljs.getLanguage(lang);
  const name = def?.name ?? lang;
  return name === 'Plain text' ? '' : name;
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

function CodePane({ code, lang }: { code: string; lang: string | null }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const known = lang && hljs.getLanguage(lang) ? lang : null;
  const html = known ? hljs.highlight(code, { language: known, ignoreIllegals: true }).value : null;
  const label = languageLabel(known) || (lang ?? '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context): nothing to do */
    }
  };

  return (
    <figure className="code">
      <figcaption className="code__head">
        <span className="code__lang">{label || t('code.label')}</span>
        <button type="button" className="code__copy" onClick={() => void copy()} aria-label={t('code.copyAria')}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </figcaption>
      {/* hljs output is escaped HTML (spans with classes only). */}
      <pre className="code__body" tabIndex={0}>
        {html !== null
          ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
          : <code className="hljs">{code}</code>}
      </pre>
    </figure>
  );
}

const components: Components = {
  // Fenced blocks arrive as <pre><code class="language-x">; we replace the <pre> wholesale.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const props = (child as { props?: ComponentPropsWithoutRef<'code'> } | undefined)?.props ?? {};
    const lang = /language-([\w#+-]+)/.exec(props.className ?? '')?.[1]?.toLowerCase() ?? null;
    return <CodePane code={textOf(props.children).replace(/\n$/, '')} lang={lang} />;
  },
  code({ children }) {
    return <code className="code-inline">{children}</code>;
  },
  a({ href, children }) {
    const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  table({ children }) {
    return <div className="md-table"><table>{children}</table></div>;
  },
  img({ alt }) {
    // No remote images in chat (they could track the owner): show the alt text instead.
    return <span className="muted">[{alt || 'image'}]</span>;
  },
};

/**
 * `onInternalLink` (v0.4 §E memory notes): links written as `#memory:<name>` call it with the
 * decoded name instead of being dropped; every other link keeps the rules above.
 */
export const RichText = memo(function RichText({ text, onInternalLink }: { text: string; onInternalLink?: (name: string) => void }) {
  const comps = useMemo<Components>(() => (onInternalLink ? {
    ...components,
    a({ href, children }) {
      if (href?.startsWith('#memory:')) {
        let name = href.slice(8);
        try { name = decodeURIComponent(name); } catch { /* keep as is */ }
        return <a href={href} className="md-wikilink" onClick={(e) => { e.preventDefault(); onInternalLink(name); }}>{children}</a>;
      }
      return components.a ? (components.a as (p: { href?: string; children?: ReactNode }) => ReactNode)({ href, children }) : <span>{children}</span>;
    },
  } : components), [onInternalLink]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={comps} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
