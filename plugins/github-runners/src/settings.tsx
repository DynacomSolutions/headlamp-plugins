import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { getJson, useConfig } from './data';
import { DEFAULT_STRIP_SUFFIXES } from './model';
import { DEFAULT_RUNWARDEN, listPath, resolveSource } from './runwarden';
import type { PluginConfig } from './types';

type TestState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; count: number }
  | { state: 'error'; message: string };

/** The Test button: asks the RunWarden service for its panel list, as the Dashboards sources do. */
function RunWardenTest({ cfg }: { cfg: PluginConfig }) {
  const [result, setResult] = React.useState<TestState>({ state: 'idle' });
  const source = resolveSource(cfg);
  const run = () => {
    setResult({ state: 'running' });
    getJson(listPath(source)).then(
      body => {
        const panels = Array.isArray(body?.panels) ? body.panels : null;
        if (panels) setResult({ state: 'ok', count: panels.length });
        else setResult({ state: 'error', message: 'The service did not return a panel list.' });
      },
      e => setResult({ state: 'error', message: String((e as Error)?.message || e) })
    );
  };
  return (
    <Box display="flex" alignItems="center" gap={1.5} flexWrap="wrap">
      <Button
        size="small"
        variant="outlined"
        disabled={source.problem !== null || result.state === 'running'}
        onClick={run}
      >
        Test
      </Button>
      <Box role="status" aria-live="polite" sx={{ minWidth: 0 }}>
        {result.state === 'running' && <Typography variant="body2">Asking RunWarden.</Typography>}
        {result.state === 'ok' && (
          <Typography variant="body2" data-test-result="ok">
            Works: {result.count} {result.count === 1 ? 'panel' : 'panels'}.
          </Typography>
        )}
        {result.state === 'error' && (
          <Alert severity="error" data-test-result="error" sx={{ py: 0 }}>
            {result.message}
          </Alert>
        )}
        {result.state === 'idle' && source.problem && (
          <Typography variant="caption" color="text.secondary">
            {source.problem}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const cfg = useConfig();
  const set = (key: keyof PluginConfig) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onDataChange?.({ ...((data || {}) as PluginConfig), [key]: e.target.value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={640}>
      <Typography variant="h6" component="h2">
        RunWarden
      </Typography>
      <Typography variant="body2">
        The page reads RunWarden when it can. RunWarden serves its widget panels on a Kubernetes
        Service. The browser reaches it through the Kubernetes API service proxy, so Kubernetes
        permissions apply (the get verb on services/proxy there). A blank field uses the default.
      </Typography>
      <TextField
        select
        label="RunWarden"
        helperText="Auto uses RunWarden and falls back to the ARC feed when it does not answer. On uses RunWarden only. Off uses the ARC feed only."
        value={['on', 'off'].includes(cfg.runwardenMode || '') ? cfg.runwardenMode : 'auto'}
        onChange={set('runwardenMode')}
        fullWidth
      >
        <MenuItem value="auto">Auto (fall back to the ARC feed)</MenuItem>
        <MenuItem value="on">On (RunWarden only)</MenuItem>
        <MenuItem value="off">Off (ARC feed only)</MenuItem>
      </TextField>
      <TextField
        label="RunWarden namespace"
        helperText="Namespace of the RunWarden widgets Service."
        value={cfg.runwardenNamespace || ''}
        onChange={set('runwardenNamespace')}
        placeholder={DEFAULT_RUNWARDEN.namespace}
        fullWidth
      />
      <TextField
        label="RunWarden service"
        helperText="Name of the Service that serves /api/widgets."
        value={cfg.runwardenService || ''}
        onChange={set('runwardenService')}
        placeholder={DEFAULT_RUNWARDEN.service}
        fullWidth
      />
      <TextField
        label="RunWarden port"
        helperText="Service port number or name."
        value={cfg.runwardenPort || ''}
        onChange={set('runwardenPort')}
        placeholder={DEFAULT_RUNWARDEN.port}
        fullWidth
      />
      <RunWardenTest cfg={cfg} />
      <Typography variant="h6" component="h2">
        ARC feed (fallback)
      </Typography>
      <Typography variant="body2">
        Everything works from Kubernetes objects alone. The optional fields below add GitHub-side
        detail and history from a JSON status endpoint (the scanner&apos;s status.json /
        history.json). The browser never holds a GitHub token; the endpoint does the API calls.
      </Typography>
      <TextField
        label="Status endpoint"
        helperText="A cluster path such as /api/v1/namespaces/NS/services/NAME:PORT/proxy/data/status.json (fetched through the Kubernetes API), or an absolute https URL. Empty disables."
        value={cfg.statusUrl || ''}
        onChange={set('statusUrl')}
        placeholder="https://status.example.com/data/status.json"
        fullWidth
      />
      <TextField
        label="History endpoint"
        helperText="Defaults to the status endpoint with status.json replaced by history.json."
        value={cfg.historyUrl || ''}
        onChange={set('historyUrl')}
        fullWidth
      />
      <TextField
        label="External worker API group"
        helperText="Optional CRD group serving 'externalworkers' (for example a laptop or Mac builder registered outside the cluster). Empty disables."
        value={cfg.externalWorkerGroup || ''}
        onChange={set('externalWorkerGroup')}
        placeholder="platform.example.com"
        fullWidth
      />
      <TextField
        label="External worker API version"
        value={cfg.externalWorkerVersion || ''}
        onChange={set('externalWorkerVersion')}
        placeholder="v1alpha1"
        fullWidth
      />
      <TextField
        label="Node display names"
        helperText="Comma-separated id=Label pairs, for example node-a=Primary,node-b=Edge."
        value={cfg.nodeAliases || ''}
        onChange={set('nodeAliases')}
        fullWidth
      />
      <TextField
        label="Pool repositories"
        helperText="Optional pool=owner/repo pairs for organisation-level pools, for example pool-a=my-org/my-repo,pool-b=my-org/other-repo."
        value={cfg.poolRepos || ''}
        onChange={set('poolRepos')}
        fullWidth
      />
      <TextField
        label="Policy: preferred nodes"
        helperText="Comma-separated node ids every pool must prefer, for example worker-1,worker-2."
        value={cfg.policyPreferredNodes || ''}
        onChange={set('policyPreferredNodes')}
        fullWidth
      />
      <TextField
        label="Policy: spill nodes"
        helperText="Comma-separated node ids every pool must be allowed to spill onto, for example worker-3."
        value={cfg.policySpillNodes || ''}
        onChange={set('policySpillNodes')}
        fullWidth
      />
      <TextField
        label="Policy: default repo cap"
        helperText="Maximum total runners (sum of maxRunners over all pools) per repository. Defaults to 3 once any policy is set."
        value={cfg.policyRepoCap ?? ''}
        onChange={set('policyRepoCap')}
        placeholder="3"
        fullWidth
      />
      <TextField
        label="Policy: repo cap overrides"
        helperText="Comma-separated owner/repo=cap pairs, for example my-org/my-repo=32."
        value={cfg.policyRepoCaps || ''}
        onChange={set('policyRepoCaps')}
        fullWidth
      />
      <TextField
        label="Project: strip prefixes"
        helperText="Comma-separated. At most one is removed from a scale set name to get the project of a job without a repository, or of a starting runner, for example ci-."
        value={cfg.projectStripPrefixes || ''}
        onChange={set('projectStripPrefixes')}
        fullWidth
      />
      <TextField
        label="Project: strip suffixes"
        helperText="Comma-separated. Removed repeatedly from the end of the scale set name used as the project fallback. Defaults to -main,-runners."
        value={cfg.projectStripSuffixes ?? DEFAULT_STRIP_SUFFIXES}
        onChange={set('projectStripSuffixes')}
        fullWidth
      />
    </Box>
  );
}
