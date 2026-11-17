import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n/I18nProvider';
import { RichText, languageLabel } from './RichText';

const render = (text: string) => renderToStaticMarkup(<I18nProvider><RichText text={text} /></I18nProvider>);

describe('RichText', () => {
  it('renders fenced code as a code pane with language, colours and a copy button', () => {
    const html = render('Run this:\n\n```powershell\nGet-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -lt 10GB }\n```');
    expect(html).toContain('<figure class="code">');
    expect(html).toContain('<span class="code__lang">PowerShell</span>');
    expect(html).toContain('class="code__copy"');
    expect(html).toContain('hljs-built_in'); // Get-PSDrive / Where-Object are coloured
    expect(html).toContain('<p>Run this:</p>');
  });

  it('handles aliases, unknown languages and no language', () => {
    expect(languageLabel('ps1')).toBe('PowerShell');
    expect(languageLabel('cmd')).toMatch(/Batch|DOS/i);
    expect(languageLabel('text')).toBe('');
    const unknown = render('```cobol\nDISPLAY "HI".\n```');
    expect(unknown).toContain('<span class="code__lang">cobol</span>');
    expect(unknown).toContain('DISPLAY &quot;HI&quot;.');
    const none = render('```\nplain output\n```');
    expect(none).toContain('<span class="code__lang">Code</span>');
    expect(none).toContain('plain output');
  });

  it('renders inline code, bold, lists, tables and keeps single line breaks', () => {
    const html = render('**Subject:** `in:sent`\nline two\n\n- a\n- b\n\n| Drive | Free |\n|---|---|\n| C: | 30% |');
    expect(html).toContain('<strong>Subject:</strong> <code class="code-inline">in:sent</code><br/>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain('<td>30%</td>');
  });

  it('is safe: no raw HTML, no script links, no remote images, code is escaped', () => {
    const html = render([
      '<img src=x onerror=alert(1)><script>alert(1)</script>',
      '[click](javascript:alert(1)) [ok](https://example.com)',
      '![tracker](https://evil.example/pixel.png)',
      '```html\n<script>alert(1)</script>\n```',
    ].join('\n\n'));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).toContain('&lt;<span class="hljs-name">script</span>&gt;');
  });
});
