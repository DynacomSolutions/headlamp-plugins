import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import React from 'react';
import { FAVOURITES, groupByProvider, ModelOption, pickerRows, providerIcon } from './chat-model';

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
  provider: 'No models are available for this provider.',
};

/** Provider sidebar entry: Favourites or one route. */
function SidebarItem(props: {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const { id, label, icon, active, onSelect } = props;
  return (
    <ButtonBase
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={() => onSelect(id)}
      sx={theme => ({
        display: 'flex',
        flexDirection: { xs: 'row', sm: 'column' },
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.25,
        px: 1,
        py: 0.75,
        borderRadius: 1,
        flexShrink: 0,
        minWidth: 56,
        color: active ? theme.palette.text.primary : theme.palette.text.secondary,
        backgroundColor: active ? theme.palette.action.selected : 'transparent',
        '&:hover': { backgroundColor: theme.palette.action.hover },
      })}
    >
      <Icon icon={icon} width={18} height={18} />
      <Typography variant="caption" noWrap sx={{ maxWidth: 64, fontSize: 10 }}>
        {label}
      </Typography>
    </ButtonBase>
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

  const providers = React.useMemo(() => groupByProvider(models), [models]);
  const sidebar = React.useMemo(() => [FAVOURITES, ...providers.map(p => p.route)], [providers]);
  const selected = models.find(m => m.id === value);
  const rows = React.useMemo(
    () => pickerRows(models, active, query, favourites),
    [models, active, query, favourites]
  );
  const flat = React.useMemo(() => rows.flatMap(r => r.models), [rows]);
  const current = Math.min(cursor, Math.max(0, flat.length - 1));
  const searching = query.trim() !== '';

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
  // Keep the highlighted row visible while the cursor, provider or search changes (DOM sync).
  React.useEffect(() => {
    if (anchor) scrollToHighlight('nearest');
  }, [anchor, current, active, query]);

  const open = (el: HTMLElement) => {
    // Open on the selected model's provider, else on favourites when there are any.
    const start = selected
      ? selected.route
      : favourites.some(f => models.some(m => m.id === f))
      ? FAVOURITES
      : providers[0]?.route ?? FAVOURITES;
    // Highlight the selected model when it is in the opening list, else the first row.
    const first = pickerRows(models, start, '', favourites).flatMap(r => r.models);
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
  const switchProvider = (id: string) => {
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
      switchProvider(sidebar[(at + step + sidebar.length) % sidebar.length]);
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

  let index = -1;
  return (
    <>
      <Button
        size="small"
        color="inherit"
        disabled={disabled}
        onClick={e => open(e.currentTarget)}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        sx={{
          textTransform: 'none',
          minWidth: 0,
          maxWidth: 260,
          color: 'text.secondary',
          gap: 0.75,
        }}
      >
        {selected && <Icon icon={providerIcon(selected.route)} width={16} height={16} />}
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
        slotProps={{ paper: { sx: { overflow: 'hidden' } } }}
      >
        <Box
          role="dialog"
          aria-label="Choose model"
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            width: { xs: 'min(92vw, 360px)', sm: 520 },
            height: { xs: 420, sm: 346 },
          }}
        >
          <Box
            role="tablist"
            aria-orientation="vertical"
            aria-label="Providers"
            sx={theme => ({
              display: 'flex',
              flexDirection: { xs: 'row', sm: 'column' },
              gap: 0.5,
              p: 0.75,
              overflow: 'auto',
              flexShrink: 0,
              borderRight: { sm: `1px solid ${theme.palette.divider}` },
              borderBottom: { xs: `1px solid ${theme.palette.divider}`, sm: 'none' },
            })}
          >
            <SidebarItem
              id={FAVOURITES}
              label="Favourites"
              icon="mdi:star"
              active={!searching && active === FAVOURITES}
              onSelect={switchProvider}
            />
            {providers.map(p => (
              <SidebarItem
                key={p.route}
                id={p.route}
                label={p.name}
                icon={providerIcon(p.route)}
                active={!searching && active === p.route}
                onSelect={switchProvider}
              />
            ))}
          </Box>
          <Box
            sx={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
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
              {rows.map(group => (
                <Box key={group.group ?? 'all'}>
                  {group.group && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', px: 1, pt: 1, pb: 0.5 }}
                    >
                      {group.group}
                    </Typography>
                  )}
                  {group.models.map(m => {
                    index += 1;
                    const highlighted = index === current;
                    const isFav = favourites.includes(m.id);
                    return (
                      <Box
                        key={m.id}
                        data-highlighted={highlighted}
                        sx={theme => ({
                          display: 'flex',
                          alignItems: 'center',
                          borderRadius: 1,
                          backgroundColor: highlighted ? theme.palette.action.hover : 'transparent',
                        })}
                      >
                        <ButtonBase
                          role="option"
                          aria-selected={m.id === value}
                          onClick={() => choose(m.id)}
                          onMouseMove={() => setCursor(flat.indexOf(m))}
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-start',
                            gap: 1,
                            px: 1,
                            py: 0.75,
                            textAlign: 'left',
                          }}
                        >
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="body2" noWrap>
                              {m.name}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              component="div"
                            >
                              {m.id}
                            </Typography>
                          </Box>
                          {m.id === value && <Icon icon="mdi:check" width={18} height={18} />}
                        </ButtonBase>
                        <IconButton
                          size="small"
                          aria-label={
                            isFav
                              ? `Remove ${m.name} from favourites`
                              : `Add ${m.name} to favourites`
                          }
                          aria-pressed={isFav}
                          onClick={() => onToggleFavourite(m.id)}
                          sx={{ color: isFav ? 'warning.main' : 'text.disabled' }}
                        >
                          <Icon
                            icon={isFav ? 'mdi:star' : 'mdi:star-outline'}
                            width={18}
                            height={18}
                          />
                        </IconButton>
                      </Box>
                    );
                  })}
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </Popover>
    </>
  );
}
