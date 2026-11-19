import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeUrl } from './a2ui/Renderer';

/*
 * Chat answers: full GFM Markdown through react-markdown, styled with the MUI theme.
 * Raw HTML is not enabled (no rehype-raw), so HTML in an answer shows as text.
 */

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard not available: leave the button unchanged.
    }
  };
  return (
    <Box
      sx={theme => ({
        position: 'relative',
        borderRadius: 1,
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.action.hover,
      })}
    >
      <IconButton
        size="small"
        aria-label={copied ? 'Copied' : 'Copy code'}
        onClick={copy}
        sx={{ position: 'absolute', top: 4, right: 4 }}
      >
        <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={16} height={16} />
      </IconButton>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          pr: 5,
          overflowX: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.85em',
        }}
      >
        <code>{code}</code>
      </Box>
    </Box>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => (
    <Typography variant="body1" component="p" sx={{ m: 0 }}>
      {children}
    </Typography>
  ),
  h1: ({ children }) => (
    <Typography variant="h5" component="h2" sx={{ mt: 1 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography variant="h6" component="h3" sx={{ mt: 1 }}>
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography variant="subtitle1" component="h4" sx={{ mt: 1, fontWeight: 600 }}>
      {children}
    </Typography>
  ),
  h4: ({ children }) => (
    <Typography variant="subtitle2" component="h5" sx={{ mt: 1 }}>
      {children}
    </Typography>
  ),
  h5: ({ children }) => (
    <Typography variant="subtitle2" component="h6">
      {children}
    </Typography>
  ),
  h6: ({ children }) => (
    <Typography variant="subtitle2" component="h6">
      {children}
    </Typography>
  ),
  ul: ({ children }) => (
    <Box component="ul" sx={{ m: 0, pl: 3, '& li': { py: 0.25 }, '& ul, & ol': { mt: 0.25 } }}>
      {children}
    </Box>
  ),
  ol: ({ children, start }) => (
    <Box
      component="ol"
      start={start ?? undefined}
      sx={{ m: 0, pl: 3, '& li': { py: 0.25 }, '& ul, & ol': { mt: 0.25 } }}
    >
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Typography variant="body1" component="li">
      {children}
    </Typography>
  ),
  a: ({ href, children }) => {
    const url = href ? safeUrl(href) : null;
    // Unsafe or missing targets (javascript:, data:, relative) show as plain text.
    if (!url) return <span>{children}</span>;
    return (
      <Link href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    );
  },
  blockquote: ({ children }) => (
    <Box
      component="blockquote"
      sx={theme => ({
        m: 0,
        pl: 2,
        borderLeft: `3px solid ${theme.palette.divider}`,
        color: theme.palette.text.secondary,
      })}
    >
      {children}
    </Box>
  ),
  hr: () => (
    <Box
      component="hr"
      sx={theme => ({ width: '100%', border: 0, borderTop: `1px solid ${theme.palette.divider}` })}
    />
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    // Fenced blocks carry a language class or end with a newline; inline code does not.
    if (/language-/.test(className ?? '') || text.includes('\n')) {
      return <CodeBlock code={text.replace(/\n$/, '')} />;
    }
    return (
      <Box
        component="code"
        sx={theme => ({
          fontFamily: 'monospace',
          fontSize: '0.9em',
          px: 0.5,
          borderRadius: 0.5,
          backgroundColor: theme.palette.action.hover,
        })}
      >
        {children}
      </Box>
    );
  },
  table: ({ children }) => (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small">{children}</Table>
    </Box>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children, style }) => (
    <TableCell component="th" sx={{ fontWeight: 600 }} align={style?.textAlign as any}>
      {children}
    </TableCell>
  ),
  td: ({ children, style }) => <TableCell align={style?.textAlign as any}>{children}</TableCell>,
  input: ({ type, checked }) =>
    type === 'checkbox' ? (
      <input type="checkbox" checked={!!checked} disabled readOnly style={{ marginRight: 6 }} />
    ) : null,
};

const PLUGINS = [remarkGfm];

export function ChatMarkdown({ source }: { source: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        wordBreak: 'break-word',
        minWidth: 0,
      }}
    >
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={u => u}>
        {source}
      </ReactMarkdown>
    </Box>
  );
}
