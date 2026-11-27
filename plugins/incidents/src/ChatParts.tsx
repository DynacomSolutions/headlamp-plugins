/*
 * The parts of a chat turn, in the look and the motion of the Arc AI chat (uiarc.dev, free design rules): a thinking
 * section and tool cards that expand on a zero-bounce height transition, an answer that is revealed smoothly, a polished
 * composer with a context meter, and a stop button that really stops the turn.
 *
 * Motion rules kept here: only transform, opacity and height move; the same element stays mounted while its state
 * changes; exits are faster than entrances; every animation has a branch for `prefers-reduced-motion`.
 * Colours come from the Headlamp (MUI) theme, so the parts work in the dark and the light theme.
 */
import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import { alpha } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import React from 'react';
import { ChatMarkdown, useCopy } from './chat-markdown';
import {
  ChatMessage,
  contextShare,
  formatCost,
  formatDuration,
  formatTokens,
  providerIcon,
  Step,
  Usage,
} from './chat-model';

/* ---------- Motion ---------- */

/** The ease of a panel that opens: no overshoot, so the height never shows a false state. */
export const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const OPEN_MS = 320;
const CLOSE_MS = 180;

export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

const keyframes = {
  '@keyframes incChatIn': {
    from: { opacity: 0, transform: 'translateY(6px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
  '@keyframes incChatFade': { from: { opacity: 0 }, to: { opacity: 1 } },
  '@keyframes incChatSettle': {
    from: { backgroundColor: 'color-mix(in srgb, var(--inc-tint) 300%, transparent)' },
    to: { backgroundColor: 'var(--inc-tint)' },
  },
  '@keyframes incChatShimmer': {
    from: { backgroundPosition: '200% 0' },
    to: { backgroundPosition: '-200% 0' },
  },
  '@keyframes incChatDots': {
    '0%, 80%, 100%': { opacity: 0.25, transform: 'scale(0.8)' },
    '40%': { opacity: 1, transform: 'scale(1)' },
  },
  '@keyframes incChatPulse': {
    '0%': { boxShadow: '0 0 0 0 var(--inc-pulse)' },
    '100%': { boxShadow: '0 0 0 10px transparent' },
  },
};
const reducedMotion = '@media (prefers-reduced-motion: reduce)';

/** A panel that opens and closes on its height. With reduced motion it appears at full height at once. */
function Reveal({ open, children, id }: { open: boolean; children: React.ReactNode; id?: string }) {
  const reduced = useReducedMotion();
  return (
    <Collapse
      in={open}
      id={id}
      unmountOnExit
      timeout={reduced ? 0 : { enter: OPEN_MS, exit: CLOSE_MS }}
      easing={{ enter: EASE, exit: 'cubic-bezier(0.4, 0, 1, 1)' }}
    >
      {children}
    </Collapse>
  );
}

/** The current time, refreshed while `active`. Drives the live duration of a running step. */
function useNow(active: boolean, everyMs = 250): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/* ---------- Smooth streaming text ---------- */

/**
 * The part of `target` to show. While `animate` is on, the shown length catches up with the target a little each
 * frame, quicker for a long answer, so a whole answer never takes more than about a second and a half.
 * With `animate` off, or with reduced motion, the whole text shows at once.
 */
export function useRevealedText(target: string, animate: boolean): string {
  const reduced = useReducedMotion();
  const on = animate && !reduced;
  const [length, setLength] = React.useState(on ? 0 : target.length);
  React.useEffect(() => {
    if (!on) return undefined;
    let frame = 0;
    let tick = 0;
    const step = () => {
      tick++;
      // Every second frame, so a long Markdown answer renders about 30 times a second at most.
      if (tick % 2 === 0) {
        setLength(current => {
          if (current >= target.length) return current;
          const remaining = target.length - current;
          return Math.min(target.length, current + Math.max(3, Math.ceil(remaining / 12)));
        });
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [on, target.length]);
  return on ? target.slice(0, Math.min(length, target.length)) : target;
}

export function StreamedAnswer({ source, animate }: { source: string; animate: boolean }) {
  const shown = useRevealedText(source, animate);
  const revealing = shown.length < source.length;
  return (
    <Box sx={{ position: 'relative', '& p, & li, & td, & th': { fontSize: 15, lineHeight: 1.65 } }}>
      <ChatMarkdown source={shown} />
      {revealing && (
        <Box
          aria-hidden
          sx={theme => ({
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: theme.palette.text.secondary,
            opacity: 0.7,
            ml: 0.5,
          })}
        />
      )}
    </Box>
  );
}

/* ---------- Thinking ---------- */

/**
 * What the model said between tool calls. It is open while the turn runs and closes when the turn ends, unless the
 * reader opened or closed it by hand.
 */
export function Reasoning({
  text,
  running,
  animate,
  provider,
  durationMs,
}: {
  text: string;
  running: boolean;
  animate: boolean;
  /** The provider of the model that answered: its mark leads the row once the turn is done. */
  provider?: string;
  durationMs?: number;
}) {
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open = manual ?? running;
  const id = React.useId();
  return (
    <Box
      sx={{
        ...keyframes,
        ...(animate && { animation: `incChatIn 220ms ${EASE} both` }),
        [reducedMotion]: { animation: 'none' },
      }}
    >
      <ButtonBase
        onClick={() => setManual(!open)}
        aria-expanded={open}
        aria-controls={id}
        sx={theme => ({
          gap: 0.75,
          borderRadius: 1.5,
          px: 0.5,
          py: 0.25,
          color: theme.palette.text.secondary,
          '&:hover, &:focus-visible': { backgroundColor: theme.palette.action.hover },
        })}
      >
        <Icon icon={running || !provider ? 'mdi:creation-outline' : providerIcon(provider)} width={16} height={16} />
        <Typography
          variant="body2"
          component="span"
          sx={theme =>
            running
              ? {
                  backgroundImage: `linear-gradient(90deg, ${theme.palette.text.secondary} 35%, ${theme.palette.text.primary} 50%, ${theme.palette.text.secondary} 65%)`,
                  backgroundSize: '200% 100%',
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  color: 'transparent',
                  animation: 'incChatShimmer 2.4s linear infinite',
                  [reducedMotion]: { animation: 'none', color: theme.palette.text.secondary },
                }
              : {}
          }
        >
          {running ? 'Thinking' : durationMs !== undefined ? `Thought for ${formatDuration(durationMs)}` : 'Reasoning'}
        </Typography>
        <Box
          component="span"
          sx={{
            display: 'flex',
            transition: `transform ${OPEN_MS}ms ${EASE}`,
            transform: open ? 'rotate(90deg)' : 'none',
            [reducedMotion]: { transition: 'none' },
          }}
        >
          <Icon icon="mdi:chevron-right" width={16} height={16} />
        </Box>
      </ButtonBase>
      <Reveal open={open} id={id}>
        <Box
          sx={theme => ({
            ml: 1.25,
            mt: 0.5,
            pl: 1.75,
            borderLeft: `2px solid ${theme.palette.divider}`,
            color: theme.palette.text.secondary,
            maxHeight: 240,
            overflowY: 'auto',
            // The thinking is quieter than the answer: smaller and muted, as in the Arc reasoning row.
            '& p, & li': { my: 0.5, fontSize: 13.5, lineHeight: 1.55, color: theme.palette.text.secondary },
          })}
        >
          <ChatMarkdown source={text} />
        </Box>
      </Reveal>
    </Box>
  );
}

/* ---------- Tool cards ---------- */

function prettyOutput(output: string): string {
  try {
    return JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    return output;
  }
}

const codeBlock = (theme: any) => ({
  m: 0,
  p: 1.25,
  borderRadius: 1.5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  maxHeight: 220,
  overflow: 'auto',
  backgroundColor: theme.palette.action.hover,
});

function StatusMark({ step }: { step: Step }) {
  if (step.status === 'running') return <CircularProgress size={14} aria-label="Running" />;
  const failed = step.ok === false;
  return (
    <Box
      role="img"
      aria-label={failed ? 'Failed' : 'Succeeded'}
      sx={{
        display: 'flex',
        color: failed ? 'error.main' : 'success.main',
        animation: `incChatFade 160ms ${EASE} both`,
        [reducedMotion]: { animation: 'none' },
      }}
    >
      <Icon icon={failed ? 'mdi:close-circle' : 'mdi:check-circle'} width={16} height={16} />
    </Box>
  );
}

/** One tool call: its name, the question it answers, its status and duration. It opens to the arguments and the result. */
export function ToolCard({ step, animate, delay = 0 }: { step: Step; animate: boolean; delay?: number }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const running = step.status === 'running';
  const now = useNow(running);
  const began = step.startedAt ? Date.parse(step.startedAt) : NaN;
  const duration =
    step.durationMs !== undefined
      ? step.durationMs
      : running && Number.isFinite(began)
      ? Math.max(0, now - began)
      : undefined;
  const hasDetail = !!step.args || !!step.output || !!step.summary;
  return (
    <Box
      data-tool-card={step.tool}
      sx={theme => ({
        ...keyframes,
        border: `1px solid ${theme.palette.divider}`,
        // A closed card is a compact chip. An open one fills the width.
        borderRadius: open ? 2 : '14px',
        width: open ? '100%' : 'fit-content',
        maxWidth: '100%',
        overflow: 'hidden',
        backgroundColor: theme.palette.background.paper,
        transition: `border-color 160ms ${EASE}`,
        '&:hover': { borderColor: theme.palette.text.disabled },
        ...(animate && { animation: `incChatIn 220ms ${EASE} ${delay}ms both` }),
        [reducedMotion]: { animation: 'none', transition: 'none' },
      })}
    >
      <ButtonBase
        onClick={() => hasDetail && setOpen(o => !o)}
        aria-expanded={hasDetail ? open : undefined}
        aria-controls={hasDetail ? id : undefined}
        disabled={!hasDetail}
        sx={theme => ({
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 1,
          px: 1.25,
          py: 0.75,
          textAlign: 'left',
          '&:hover, &:focus-visible': { backgroundColor: theme.palette.action.hover },
          '&.Mui-disabled': { opacity: 1 },
        })}
      >
        <Box sx={{ display: 'flex', width: 16, justifyContent: 'center', flexShrink: 0 }}>
          <StatusMark step={step} />
        </Box>
        <Typography
          component="span"
          sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, flexShrink: 0 }}
        >
          {step.tool}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          sx={{ flex: 1, minWidth: 0 }}
          title={step.reason}
        >
          {step.reason}
        </Typography>
        {duration !== undefined && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
          >
            {formatDuration(duration)}
          </Typography>
        )}
        {hasDetail && (
          <Box
            component="span"
            sx={{
              display: 'flex',
              color: 'text.secondary',
              transition: `transform ${OPEN_MS}ms ${EASE}`,
              transform: open ? 'rotate(90deg)' : 'none',
              [reducedMotion]: { transition: 'none' },
            }}
          >
            <Icon icon="mdi:chevron-right" width={16} height={16} />
          </Box>
        )}
      </ButtonBase>
      <Reveal open={open} id={id}>
        <Box sx={{ px: 1.25, pb: 1.25, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {step.args && (
            <Box>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                Arguments
              </Typography>
              <Box component="pre" sx={codeBlock}>
                {JSON.stringify(step.args, null, 2)}
              </Box>
            </Box>
          )}
          {(step.output || step.summary) && (
            <Box>
              <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                {step.ok === false ? 'Error' : 'Result'}
              </Typography>
              {step.summary && (
                <Typography variant="body2" sx={{ mb: step.output ? 0.75 : 0, wordBreak: 'break-word' }}>
                  {step.summary}
                </Typography>
              )}
              {step.output && (
                <Box component="pre" sx={codeBlock}>
                  {prettyOutput(step.output)}
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Reveal>
    </Box>
  );
}

/** The tool calls of one turn. Open while the turn runs, closed after it, unless the reader chose. */
export function ToolList({
  steps,
  running,
  animate,
}: {
  steps: Step[];
  running: boolean;
  animate: boolean;
}) {
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open = manual ?? running;
  const id = React.useId();
  const busy = running && steps.some(s => s.status === 'running');
  const failed = steps.filter(s => s.ok === false).length;
  const label = busy
    ? `Working, ${steps.length} ${steps.length === 1 ? 'tool call' : 'tool calls'}`
    : `Used ${steps.length} ${steps.length === 1 ? 'tool' : 'tools'}${failed ? `, ${failed} failed` : ''}`;
  return (
    <Box>
      <ButtonBase
        onClick={() => setManual(!open)}
        aria-expanded={open}
        aria-controls={id}
        sx={theme => ({
          gap: 0.75,
          borderRadius: 1.5,
          px: 0.5,
          py: 0.25,
          color: theme.palette.text.secondary,
          '&:hover, &:focus-visible': { backgroundColor: theme.palette.action.hover },
        })}
      >
        {busy ? (
          <CircularProgress size={14} aria-label="Working" />
        ) : (
          <Icon icon="mdi:wrench-outline" width={16} height={16} />
        )}
        <Typography variant="body2">{label}</Typography>
        <Box
          component="span"
          sx={{
            display: 'flex',
            transition: `transform ${OPEN_MS}ms ${EASE}`,
            transform: open ? 'rotate(90deg)' : 'none',
            [reducedMotion]: { transition: 'none' },
          }}
        >
          <Icon icon="mdi:chevron-right" width={16} height={16} />
        </Box>
      </ButtonBase>
      <Reveal open={open} id={id}>
        <Box
          component="ul"
          sx={{ listStyle: 'none', m: 0, mt: 0.75, p: 0, display: 'flex', flexDirection: 'column', gap: 0.75 }}
        >
          {steps.map((s, i) => (
            <Box component="li" key={s.id}>
              <ToolCard step={s} animate={animate} delay={Math.min(i, 6) * 35} />
            </Box>
          ))}
        </Box>
      </Reveal>
    </Box>
  );
}

/* ---------- Cards of the conversation ---------- */

/** One button style for the whole chat: sentence case, a pill. MUI upper-cases a button by default. */
export const chatButtonSx = {
  textTransform: 'none',
  borderRadius: 999,
  fontWeight: 500,
  letterSpacing: 0,
} as const;

/**
 * A card that flows in the conversation, in the style of a tool card: a header row with an icon, a title and a short
 * status, a chevron, and a body that opens and closes on its height. A highlighted card is the item that a link named:
 * it gets a faint tint that settles after a moment, never a border or a side bar. Buttons inside it have the chat button style.
 */
export function CardSection({
  icon,
  title,
  meta,
  defaultOpen = true,
  highlighted,
  children,
  cardRef,
}: {
  icon: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  highlighted?: boolean;
  children: React.ReactNode;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const [open, setOpen] = React.useState(defaultOpen || !!highlighted);
  const id = React.useId();
  return (
    <Box
      ref={cardRef}
      data-chat-card
      data-highlighted={highlighted ? 'true' : undefined}
      sx={theme => ({
        ...keyframes,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 2,
        overflow: 'hidden',
        minWidth: 0,
        overflowWrap: 'anywhere',
        '--inc-tint': alpha(theme.palette.primary.main, 0.08),
        backgroundColor: highlighted ? 'var(--inc-tint)' : theme.palette.background.paper,
        transition: `background-color 160ms ${EASE}`,
        // A linked card draws the eye once: its tint starts stronger and settles.
        animation: highlighted
          ? `incChatIn 220ms ${EASE} both, incChatSettle 1800ms ${EASE} 220ms both`
          : `incChatIn 220ms ${EASE} both`,
        '& .MuiButton-root': chatButtonSx,
        [reducedMotion]: { animation: 'none', transition: 'none' },
      })}
    >
      <ButtonBase
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={id}
        sx={theme => ({
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          gap: 1,
          px: 1.5,
          py: 1,
          textAlign: 'left',
          '&:hover, &:focus-visible': { backgroundColor: theme.palette.action.hover },
        })}
      >
        <Box component="span" sx={{ display: 'flex', color: 'text.secondary' }}>
          <Icon icon={icon} width={18} height={18} />
        </Box>
        <Typography component="h2" variant="subtitle2" fontWeight={600} sx={{ flex: 1, minWidth: 0 }}>
          {title}
        </Typography>
        {meta && (
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {meta}
          </Typography>
        )}
        <Box
          component="span"
          sx={{
            display: 'flex',
            color: 'text.secondary',
            transition: `transform ${OPEN_MS}ms ${EASE}`,
            transform: open ? 'rotate(90deg)' : 'none',
            [reducedMotion]: { transition: 'none' },
          }}
        >
          <Icon icon="mdi:chevron-right" width={16} height={16} />
        </Box>
      </ButtonBase>
      <Reveal open={open} id={id}>
        <Box sx={{ px: 1.5, pb: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>{children}</Box>
      </Reveal>
    </Box>
  );
}

/* ---------- Working indicator, usage line, context meter ---------- */

/** Three dots and the elapsed time, while the agent works and has nothing to show yet. */
export function WorkingIndicator({ since, label }: { since: string; label: string }) {
  const now = useNow(true, 1000);
  const began = Date.parse(since);
  const elapsed = Number.isFinite(began) ? Math.max(0, now - began) : 0;
  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{ ...keyframes, display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}
    >
      <Box aria-hidden sx={{ display: 'flex', gap: '3px' }}>
        {[0, 1, 2].map(i => (
          <Box
            key={i}
            component="span"
            sx={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              backgroundColor: 'currentColor',
              animation: `incChatDots 1.2s ${EASE} ${i * 160}ms infinite`,
              [reducedMotion]: { animation: 'none', opacity: 0.6 },
            }}
          />
        ))}
      </Box>
      <Typography variant="body2" component="span">
        {label}
      </Typography>
      <Typography variant="caption" component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatDuration(elapsed)}
      </Typography>
    </Box>
  );
}

/** Model, identity, tokens, cost and time of one answer. */
export function UsageLine({
  model,
  usage,
  toolCalls,
  copy,
}: {
  model?: string;
  usage?: Usage;
  toolCalls: number;
  /** The answer, for the copy button. */
  copy?: string;
}) {
  const slash = model ? model.indexOf('/') : -1;
  const name = model ? (slash > 0 ? model.slice(slash + 1) : model) : '';
  const parts: { key: string; text: string; title?: string }[] = [];
  if (name) parts.push({ key: 'model', text: name, title: model });
  if (usage?.identity) parts.push({ key: 'identity', text: usage.identity, title: 'Identity' });
  if (usage && (usage.inputTokens || usage.outputTokens)) {
    parts.push({
      key: 'tokens',
      text: `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out`,
      title: `${usage.inputTokens.toLocaleString()} tokens in, ${usage.outputTokens.toLocaleString()} tokens out`,
    });
  }
  if (usage?.costUsd !== undefined) parts.push({ key: 'cost', text: formatCost(usage.costUsd), title: 'Cost' });
  if (usage?.durationMs !== undefined) parts.push({ key: 'time', text: formatDuration(usage.durationMs) });
  if (toolCalls > 0) parts.push({ key: 'tools', text: `${toolCalls} ${toolCalls === 1 ? 'tool call' : 'tool calls'}` });
  if (!parts.length && !copy) return null;
  return (
    <Box
      data-usage-line
      sx={{
        ...keyframes,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 0,
        rowGap: 0.25,
        color: 'text.secondary',
        fontVariantNumeric: 'tabular-nums',
        animation: `incChatFade 240ms ${EASE} both`,
        [reducedMotion]: { animation: 'none' },
      }}
    >
      {copy && <CopyButton text={copy} />}
      {parts.map((p, i) => (
        <Typography
          key={p.key}
          variant="caption"
          component="span"
          title={p.title}
          // The dot belongs to the item after it, so a line never ends with a lone dot.
          sx={i > 0 ? { ml: 1, '&::before': { content: '"·"', opacity: 0.5, mr: 1 } } : undefined}
        >
          {p.text}
        </Typography>
      ))}
    </Box>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, copyText] = useCopy();
  const copy = () => copyText(text);
  return (
    <Tooltip title={copied ? 'Copied' : 'Copy the answer'}>
      <IconButton size="small" aria-label="Copy the answer" onClick={copy} sx={{ color: 'text.secondary', mr: 0.25 }}>
        <Icon icon={copied ? 'mdi:check' : 'mdi:content-copy'} width={15} height={15} />
      </IconButton>
    </Tooltip>
  );
}

/** The tokens in the context against the window of the selected model, as a ring and a figure. */
export function ContextMeter({ used, window }: { used: number; window?: number }) {
  const share = contextShare(used, window);
  const percent = share === undefined ? undefined : Math.round(share * 100);
  const colour = share === undefined ? 'text.secondary' : share >= 0.95 ? 'error.main' : share >= 0.8 ? 'warning.main' : 'primary.main';
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const text =
    window === undefined
      ? used > 0
        ? `${formatTokens(used)} tokens`
        : ''
      : `${formatTokens(used)} / ${formatTokens(window)}`;
  if (!text) return null;
  const title =
    window === undefined
      ? `${used.toLocaleString()} tokens in the context. The size of the window is not known.`
      : `Context window: ${used.toLocaleString()} of ${window.toLocaleString()} tokens (${percent}%)`;
  return (
    <Tooltip title={title}>
      <Box
        role={window === undefined ? 'img' : 'meter'}
        aria-label="Context window"
        aria-valuemin={window === undefined ? undefined : 0}
        aria-valuemax={window}
        aria-valuenow={window === undefined ? undefined : Math.min(used, window)}
        aria-valuetext={title}
        tabIndex={0}
        data-context-meter
        sx={theme => ({
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          px: 0.75,
          py: 0.25,
          borderRadius: 2,
          color: theme.palette.text.secondary,
          fontVariantNumeric: 'tabular-nums',
          cursor: 'default',
          '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}` },
        })}
      >
        {window !== undefined && (
          <Box component="svg" width={18} height={18} viewBox="0 0 18 18" aria-hidden sx={{ transform: 'rotate(-90deg)', color: colour }}>
            <circle cx={9} cy={9} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
            <Box
              component="circle"
              cx={9}
              cy={9}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - (share ?? 0))}
              sx={{
                transition: `stroke-dashoffset 400ms ${EASE}, stroke 200ms`,
                [reducedMotion]: { transition: 'none' },
              }}
            />
          </Box>
        )}
        <Typography variant="caption" component="span" sx={{ lineHeight: 1 }}>
          {text}
        </Typography>
      </Box>
    </Tooltip>
  );
}

/* ---------- A turn ---------- */

/** The last model call's context tokens of a message list, for the meter: the context now. */
export function latestContext(messages: ChatMessage[]): { used: number; window?: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].usage;
    if (usage && usage.contextTokens > 0) return { used: usage.contextTokens, window: usage.contextWindow };
  }
  return { used: 0 };
}

export function MessageView({ m, extra }: { m: ChatMessage; extra?: React.ReactNode }) {
  const running = m.status === 'running';
  // A message that was seen running animates in: its tool cards, its answer. A message from the history shows at once.
  const [watched, setWatched] = React.useState(running);
  if (running && !watched) setWatched(true);

  if (m.role === 'user') {
    return (
      <Box sx={{ ...keyframes, display: 'flex', justifyContent: 'flex-end' }}>
        <Box
          sx={theme => ({
            maxWidth: '85%',
            px: 2,
            py: 1.25,
            borderRadius: '20px 20px 6px 20px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            backgroundColor: theme.palette.action.selected,
            animation: `incChatIn 200ms ${EASE} both`,
            [reducedMotion]: { animation: 'none' },
          })}
        >
          <Typography variant="body1" component="div">
            {m.text}
          </Typography>
        </Box>
      </Box>
    );
  }
  const latest = m.steps.find(s => s.status === 'running');
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {m.thinking && (
        <Reasoning
          text={m.thinking}
          running={running}
          animate={watched}
          provider={m.usage?.provider}
          durationMs={m.usage?.durationMs}
        />
      )}
      {m.steps.length > 0 && <ToolList steps={m.steps} running={running} animate={watched} />}
      {m.text && <StreamedAnswer source={m.text} animate={watched} />}
      {running && !m.text && (
        <WorkingIndicator
          since={m.createdAt}
          label={latest ? `Running ${latest.tool}` : m.steps.length ? 'Working' : 'Thinking'}
        />
      )}
      {m.status === 'failed' && <Alert severity="error">{m.error || 'The turn failed.'}</Alert>}
      {m.status === 'cancelled' && (
        <Typography variant="caption" color="text.secondary">
          Stopped.
        </Typography>
      )}
      {!running && (
        <UsageLine model={m.model} usage={m.usage} toolCalls={m.steps.length} copy={m.text || undefined} />
      )}
      {extra}
    </Box>
  );
}

/* ---------- Composer ---------- */

/**
 * The message box. The model and identity picker and the context meter sit in its footer. While a turn runs the send
 * button becomes a stop button in the same place, with a soft ring, and the stop really ends the turn on the agent.
 */
export function Composer(props: {
  running: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  picker: React.ReactNode;
  /** Next to the picker: the context meter. */
  meter?: React.ReactNode;
  placeholder?: string;
}) {
  const { running, disabled, onSend, onStop, picker, meter, placeholder } = props;
  const [text, setText] = React.useState('');
  const field = React.useRef<HTMLTextAreaElement | null>(null);
  const canSend = !running && !disabled && text.trim() !== '';
  const stopping = running && !!onStop;
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
    if (field.current) field.current.style.height = 'auto';
  };
  return (
    <Box
      sx={theme => ({
        ...keyframes,
        '--inc-pulse': alpha(theme.palette.text.primary, 0.25),
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: '24px',
        p: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        backgroundColor: theme.palette.background.paper,
        transition: `border-color 160ms ${EASE}, box-shadow 160ms ${EASE}`,
        '&:focus-within': {
          borderColor: theme.palette.primary.main,
          boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.14)}`,
        },
        [reducedMotion]: { transition: 'none' },
      })}
    >
      <Box
        component="textarea"
        ref={field}
        aria-label="Message"
        aria-keyshortcuts="Enter"
        placeholder={placeholder ?? 'Ask about the cluster or an incident'}
        rows={1}
        maxLength={8000}
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
          setText(e.target.value);
          fit(e.target);
        }}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        sx={theme => ({
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: theme.palette.text.primary,
          font: 'inherit',
          // 16px on a phone, so the browser does not zoom the page on focus.
          fontSize: { xs: 16, sm: 15 },
          px: 1,
          py: 0.75,
          minHeight: 28,
          maxHeight: 200,
          overflow: 'auto',
          '&::placeholder': { color: theme.palette.text.disabled },
        })}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, flexWrap: 'wrap' }}>
          {picker}
          {meter}
        </Box>
        <ButtonBase
          aria-label={stopping ? 'Stop' : 'Send'}
          disabled={stopping ? false : !canSend}
          onClick={stopping ? onStop : send}
          sx={theme => ({
            width: 36,
            height: 36,
            flexShrink: 0,
            borderRadius: '50%',
            color: stopping || canSend ? theme.palette.primary.contrastText : theme.palette.text.disabled,
            backgroundColor: stopping || canSend ? theme.palette.primary.main : theme.palette.action.disabledBackground,
            transition: `background-color 160ms ${EASE}, color 160ms ${EASE}, transform 120ms ${EASE}`,
            '&:active:not(.Mui-disabled)': { transform: 'scale(0.97)' },
            '&:focus-visible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
            ...(stopping && { animation: 'incChatPulse 1.6s ease-out infinite' }),
            [reducedMotion]: { transition: 'none', animation: 'none' },
          })}
        >
          <Icon icon={stopping ? 'mdi:stop' : 'mdi:arrow-up'} width={20} height={20} />
        </ButtonBase>
      </Box>
    </Box>
  );
}
