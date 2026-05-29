import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { Check, Copy } from 'lucide-react';

type MarkdownContentProps = {
  children: string;
};

function normalizeLatexDelimiters(value: string) {
  return value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, content: string) => `$$${content}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, content: string) => `$${content}$`);
}

async function copyText(value: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function MarkdownContent({ children }: MarkdownContentProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyText(children);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group relative">
      <button
        type="button"
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => void handleCopy()}
        className={`absolute right-0 top-0 inline-flex h-8 min-w-8 items-center justify-center rounded-full border px-2 shadow-sm transition ${
          copied
            ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
            : 'border-violet-100 bg-white/90 text-violet-500 opacity-80 hover:border-violet-200 hover:bg-violet-50 hover:opacity-100'
        }`}
      >
        {copied ? <Check size={14} strokeWidth={2.6} /> : <Copy size={14} strokeWidth={2.3} />}
      </button>
      <div className="markdown-body pr-10">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {normalizeLatexDelimiters(children)}
        </ReactMarkdown>
      </div>
    </div>
  );
}
