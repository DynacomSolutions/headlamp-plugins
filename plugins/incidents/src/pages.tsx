import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { Link as RouterLink, useHistory, useParams } from 'react-router-dom';
import { A2uiRenderer } from './a2ui';
import { useDiagnoses, useDiagnosis, useSettings } from './data';
import { DiagnosisSummary, severityColour, Status } from './model';

const STATUS_COLOUR: Record<Status, 'default' | 'info' | 'success' | 'error'> = {
  queued: 'default',
  running: 'info',
  done: 'success',
  failed: 'error',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Row({ d }: { d: DiagnosisSummary }) {
  const history = useHistory();
  const open = () => history.push(`/incidents/${encodeURIComponent(d.id)}`);
  return (
    <TableRow hover sx={{ cursor: 'pointer' }} onClick={open}>
      <TableCell>{formatTime(d.createdAt)}</TableCell>
      <TableCell>
        <Link
          component={RouterLink}
          to={`/incidents/${encodeURIComponent(d.id)}`}
          onClick={e => e.stopPropagation()}
        >
          {d.alertName || d.id}
        </Link>
      </TableCell>
      <TableCell>
        <Chip size="small" label={d.severity || 'none'} color={severityColour(d.severity)} />
      </TableCell>
      <TableCell>
        <Chip size="small" variant="outlined" label={d.status} color={STATUS_COLOUR[d.status]} />
      </TableCell>
      <TableCell sx={{ maxWidth: 480 }}>{d.likelyCause}</TableCell>
      <TableCell>{d.confidence}</TableCell>
      <TableCell>{d.source}</TableCell>
      <TableCell>{d.resolved ? 'yes' : 'no'}</TableCell>
    </TableRow>
  );
}

export function IncidentsPage() {
  const settings = useSettings();
  const { data, loading, error } = useDiagnoses(settings);
  return (
    <SectionBox title="Incidents">
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load diagnoses: {error}
        </Alert>
      )}
      {loading && !data ? (
        <CircularProgress aria-label="Loading" />
      ) : data && data.length === 0 ? (
        <Typography>No diagnoses yet.</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              {[
                'Time',
                'Alert',
                'Severity',
                'Status',
                'Likely cause',
                'Confidence',
                'Source',
                'Resolved',
              ].map(h => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {(data ?? []).map(d => (
              <Row key={d.id} d={d} />
            ))}
          </TableBody>
        </Table>
      )}
    </SectionBox>
  );
}

export function IncidentPage() {
  const { id } = useParams<{ id: string }>();
  const settings = useSettings();
  const { data, loading, error } = useDiagnosis(settings, id);
  return (
    <SectionBox
      title={
        <Box display="flex" alignItems="center" gap={2}>
          <Link component={RouterLink} to="/incidents">
            Back to incidents
          </Link>
          <Typography variant="h5" component="span">
            Incident
          </Typography>
        </Box>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load the diagnosis: {error}
        </Alert>
      )}
      {loading && !data ? (
        <CircularProgress aria-label="Loading" />
      ) : data ? (
        <A2uiRenderer messages={data.a2ui} />
      ) : null}
    </SectionBox>
  );
}
