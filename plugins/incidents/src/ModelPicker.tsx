/*
 * The model picker, in the layout of the T3 Code picker: a narrow icon rail with Favourites and one entry per
 * instance, then a search box and one list of model rows. An instance is an identity of a provider: the gateway
 * app (the pool, or one pinned account) that the agent reaches the provider through. When a provider has several
 * identities, each shows a small badge with the initials of its identity, and the tooltip names both.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  FAVOURITES,
  Instance,
  instancesOf,
  ModelOption,
  pickerRows,
  providerIcon,
} from './chat-model';

export interface ModelPickerProps {
  models: ModelOption[];
  /** Selected model id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  favourites: string[];
  onToggleFavourite: (id: string) => void;
  disabled?: boolean;
}

const EMPTY_TEXT = {
  favourites: 'No favourites yet',
  search: 'No models found',
  provider: 'No models are available for this identity.',
};

const RAIL_WIDTH = 44;
const reduceMotion = '@media (prefers-reduced-motion: reduce)';

/** The provider mark with the small identity badge, as T3 Code draws an instance. */
export function InstanceIcon(props: {
  instance: Pick<Instance, 'provider' | 'showBadge' | 'badge'>;
  size?: number;
  background?: string;
}) {
  const { instance, size = 20, background = 'transparent' } = props;
  return (
    <Box
      component="span"
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <Icon icon={providerIcon(instance.provider)} width={size} height={size} />
      {instance.showBadge && (
        <Box
          component="span"
          aria-hidden
          sx={theme => ({
            position: 'absolute',
            right: -5,
            bottom: -5,
            minWidth: 14,
            height: 14,
            px: '2px',
            borderRadius: 7,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 8,
            fontWeight: 600,
            lineHeight: 1,
            letterSpacing: 0,
            color: theme.palette.text.secondary,
            backgroundColor: theme.palette.background.paper,
            border: `1.5px solid ${background === 'transparent' ? theme.palette.background.paper : background}`,
            boxShadow: `0 0 0 0.5px ${theme.palette.divider}`,
          })}
        >
          {instance.badge}
        </Box>
      )}
    </Box>
  );
}

/** Rail entry: Favourites, or one instance. */
function RailItem(props: {
  id: string;
  label: string;
  active: boolean;
  onSelect: (id: string) => void;
  children: React.ReactNode;
}) {
  const { id, label, active, onSelect, children } = props;
  return (
    <Box data-picker-rail-item={id} sx={{ position: 'relative' }}>
      <Tooltip title={label} placement="left" arrow enterDelay={300}>
        <ButtonBase
          role="tab"
          aria-selected={active}
          aria-label={label}
          onClick={() => onSelect(id)}
          sx={theme => ({
            width: '100%',
            aspectRatio: '1',
            borderRadius: 1.5,
            color: active ? theme.palette.text.primary : theme.palette.text.secondary,
            transition: 'background-color 160ms, color 160ms',
            '&:hover, &:focus-visible': { backgroundColor: theme.palette.action.hover },
            [reduceMotion]: { transition: 'none' },
          })}
        >
          {children}
        </ButtonBase>
      </Tooltip>
    </Box>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const { models, value, onChange, favourites, onToggleFavourite, disabled } = props;
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const [active, setActive] = React.useState<string>(FAVOURITES);
  const [query, setQuery] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  // Focus the search box when the popover content mounts (stable callback, so it runs once).
  const focusOnMount = React.useCallback((el: HTMLInputElement | null) => el?.focus(), []);

  const instances = React.useMemo(() => instancesOf(models), [models]);
  const instanceOf = React.useCallback(
    (route: string) => instances.find(i => i.route === route),
    [instances]
  );
  const sidebar = React.useMemo(() => [FAVOURITES, ...instances.map(i => i.route)], [instances]);
  const selected = models.find(m => m.id === value);
  const selectedInstance = selected ? instanceOf(selected.route) : undefined;
  const flat = React.useMemo(
    () => pickerRows(models, active, query, favourites),
    [models, active, query, favourites]
  );
  const current = Math.min(cursor, Math.max(0, flat.length - 1));
  const searching = query.trim() !== '';
  const activeIndex = Math.max(0, sidebar.indexOf(active));

  const scrollToHighlight = (block: ScrollLogicalPosition) => {
    const el = listRef.current?.querySelector('[data-highlighted="true"]');
    (el as HTMLElement | null)?.scrollIntoView?.({ block });
  };
  // The popover content mounts after the picker commits (portal), so the list is not in the
  // DOM when an effect keyed on the anchor runs. A callback ref runs when the list mounts.
  const setList = React.useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    if (el)
      (el.querySelector('[data-highlighted="true"]') as HTMLElement | null)?.scrollIntoView?.({
        block: 'center',
      });
  }, []);
  // Keep the highlighted row visible while the cursor, identity or search changes (DOM sync).
  React.useEffect(() => {
    if (anchor) scrollToHighlight('nearest');
  }, [anchor, current, active, query]);

  const open = (el: HTMLElement) => {
    // Open on the selected model's identity, else on favourites when there are any.
    const start = selected
      ? selected.route
      : favourites.some(f => models.some(m => m.id === f))
      ? FAVOURITES
      : instances[0]?.route ?? FAVOURITES;
    // Highlight the selected model when it is in the opening list, else the first row.
    const first = pickerRows(models, start, '', favourites);
    setActive(start);
    setQuery('');
    setCursor(
      Math.max(
        0,
        first.findIndex(m => m.id === value)
      )
    );
    setAnchor(el);
  };
  const close = () => setAnchor(null);
  const choose = (id: string) => {
    onChange(id);
    close();
  };
  const switchInstance = (id: string) => {
    setActive(id);
    setCursor(0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setCursor((current + step + flat.length) % flat.length);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !searching) {
      e.preventDefault();
      const at = sidebar.indexOf(active);
      const step = e.key === 'ArrowRight' ? 1 : -1;
      switchInstance(sidebar[(at + step + sidebar.length) % sidebar.length]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[current]) choose(flat[current].id);
    }
  };

  const emptyText = searching
    ? EMPTY_TEXT.search
    : active === FAVOURITES
    ? EMPTY_TEXT.favourites
    : EMPTY_TEXT.provider;

  const triggerLabel = selected
    ? selectedInstance?.showBadge
      ? `${selected.name}, ${selectedInstance.identity}`
      : selected.name
    : value || 'Choose model';

  return (
    <>
      <Button
        size="small"
        color="inherit"
        disabled={disabled}
        onClick={e => open(e.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        aria-label={triggerLabel}
        sx={{
          textTransform: 'none',
          minWidth: 0,
          maxWidth: 260,
          color: 'text.secondary',
          gap: 0.75,
          borderRadius: 2,
          px: 1,
        }}
      >
        {selectedInstance && <InstanceIcon instance={selectedInstance} size={16} />}
        <Typography variant="body2" noWrap component="span">
          {selected ? selected.name : value || 'Choose model'}
        </Typography>
        <Icon icon="mdi:chevron-down" width={16} height={16} />
      </Button>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { overflow: 'hidden', borderRadius: 3 } } }}
      >
        <Box
          role="dialog"
          aria-label="Choose model"
          sx={{
            display: 'flex',
            flexDirection: 'row',
            width: 'min(92vw, 360px)',
            height: 'min(346px, 70vh)',
          }}
        >
          <Box
            role="tablist"
            aria-orientation="vertical"
            aria-label="Providers and identities"
            data-picker-rail
            sx={theme => ({
              position: 'relative',
              width: RAIL_WIDTH,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 0.5,
              p: 0.5,
              overflowY: 'auto',
              scrollbarWidth: 'none',
              '&::-webkit-scrollbar': { display: 'none' },
              backgroundColor: theme.palette.action.hover,
            })}
          >
            {/* The selection bar glides to the active entry, as in the T3 Code rail. */}
            <Box
              aria-hidden
              data-picker-indicator
              sx={theme => ({
                position: 'absolute',
                right: 2,
                top: 0,
                width: 3,
                height: 20,
                borderRadius: 2,
                backgroundColor: theme.palette.primary.main,
                // Entries are square (rail width minus padding), plus the divider after Favourites.
                transform: `translateY(${
                  4 + activeIndex * (RAIL_WIDTH - 8 + 4) + (activeIndex > 0 ? 5 : 0) + (RAIL_WIDTH - 8) / 2 - 10
                }px)`,
                transition: 'transform 240ms cubic-bezier(0.2, 0, 0, 1)',
                opacity: searching ? 0 : 1,
                [reduceMotion]: { transition: 'none' },
              })}
            />
            <RailItem
              id={FAVOURITES}
              label="Favourites"
              active={!searching && active === FAVOURITES}
              onSelect={switchInstance}
            >
              <Icon icon="mdi:star" width={20} height={20} />
            </RailItem>
            <Box aria-hidden sx={theme => ({ borderBottom: `1px solid ${theme.palette.divider}`, mx: 0.5 })} />
            {instances.map(instance => (
              <RailItem
                key={instance.route}
                id={instance.route}
                label={instance.label}
                active={!searching && active === instance.route}
                onSelect={switchInstance}
              >
                <InstanceIcon instance={instance} size={22} />
              </RailItem>
            ))}
          </Box>
          <Box
            sx={theme => ({
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              borderLeft: `1px solid ${theme.palette.divider}`,
            })}
          >
            <Box
              sx={theme => ({
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1,
                borderBottom: `1px solid ${theme.palette.divider}`,
              })}
            >
              <Icon icon="mdi:magnify" width={18} height={18} />
              <InputBase
                inputRef={focusOnMount}
                fullWidth
                placeholder="Search models..."
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={onKeyDown}
                inputProps={{ 'aria-label': 'Search models' }}
              />
            </Box>
            <Box
              ref={setList}
              role="listbox"
              aria-label="Models"
              sx={{ flex: 1, overflow: 'auto', p: 0.5 }}
            >
              {flat.length === 0 && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ p: 2, textAlign: 'center' }}
                >
                  {emptyText}
                </Typography>
              )}
              {flat.map((m, index) => {
                const instance = instanceOf(m.route);
                const highlighted = index === current;
                const isFav = favourites.includes(m.id);
                return (
                  <Box
                    key={m.id}
                    data-highlighted={highlighted}
                    className="model-row"
                    sx={theme => ({
                      display: 'flex',
                      alignItems: 'center',
                      borderRadius: 1.5,
                      backgroundColor: highlighted ? theme.palette.action.hover : 'transparent',
                      '& .model-star': { opacity: isFav ? 1 : 0 },
                      '&:hover .model-star, &:focus-within .model-star, &[data-highlighted="true"] .model-star': {
                        opacity: 1,
                      },
                      '@media (pointer: coarse)': { '& .model-star': { opacity: 1 } },
                    })}
                  >
                    <ButtonBase
                      role="option"
                      aria-label={`${m.name}, ${instance?.label ?? m.route}`}
                      aria-selected={m.id === value}
                      onClick={() => choose(m.id)}
                      onMouseMove={() => setCursor(index)}
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-start',
                        gap: 1.25,
                        px: 1,
                        py: 0.875,
                        textAlign: 'left',
                        borderRadius: 1.5,
                      }}
                    >
                      {instance && <InstanceIcon instance={instance} size={16} />}
                      <Typography variant="body2" noWrap sx={{ flex: '0 1 auto', minWidth: 0 }}>
                        {m.name}
                      </Typography>
                      {m.id === value && <Icon icon="mdi:check" width={16} height={16} />}
                    </ButtonBase>
                    <Tooltip title={isFav ? 'Remove from favourites' : 'Add to favourites'}>
                      <IconButton
                        className="model-star"
                        size="small"
                        aria-label={
                          isFav
                            ? `Remove ${m.name} from favourites`
                            : `Add ${m.name} to favourites`
                        }
                        aria-pressed={isFav}
                        onClick={() => onToggleFavourite(m.id)}
                        sx={{
                          color: isFav ? 'warning.main' : 'text.disabled',
                          transition: 'opacity 120ms',
                          [reduceMotion]: { transition: 'none' },
                        }}
                      >
                        <Icon
                          icon={isFav ? 'mdi:star' : 'mdi:star-outline'}
                          width={16}
                          height={16}
                        />
                      </IconButton>
                    </Tooltip>
                  </Box>
                );
              })}
            </Box>
          </Box>
        </Box>
      </Popover>
    </>
  );
}
