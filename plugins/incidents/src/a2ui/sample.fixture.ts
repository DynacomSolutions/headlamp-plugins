import type { A2uiMessage } from './types';

/** Hand-written equivalent of the surface the agent renders for a finished diagnosis. */
export const sampleDiagnosis: A2uiMessage[] = [
  {
    version: '1.0',
    createSurface: {
      surfaceId: 'diagnosis_d1',
      catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
      components: [
        { id: 'c1', component: 'Icon', name: 'warning' },
        { id: 'c2', component: 'Text', text: '## NodeDiskPressure' },
        { id: 'c3', component: 'Row', children: ['c1', 'c2'], justify: 'start', align: 'center' },
        { id: 'c4', component: 'Text', text: '**Disk on worker-1 is nearly full**' },
        {
          id: 'c5',
          component: 'Text',
          text: 'warning · high confidence · 3/12 tool calls · model-x · 2026-01-01 10:00 UTC',
          variant: 'caption',
        },
        { id: 'c6', component: 'Divider' },
        { id: 'c7', component: 'Text', text: 'The image cache filled /var on worker-1.' },
        { id: 'c8', component: 'Text', text: '**Evidence**' },
        { id: 'c9', component: 'Text', text: '✓ Usage is 96%  \n_e1, e2_' },
        { id: 'c10', component: 'List', children: ['c9'] },
        { id: 'c11', component: 'Text', text: '**Suggested fixes**' },
        { id: 'c12', component: 'Text', text: '1. **Prune unused images** (recommended)' },
        { id: 'c13', component: 'Text', text: 'Remove images no pod uses.', variant: 'caption' },
        { id: 'c14', component: 'Text', text: '`kubectl get pods -A`', variant: 'caption' },
        { id: 'c15', component: 'Column', children: ['c12', 'c13', 'c14'] },
        { id: 'c16', component: 'List', children: ['c15'] },
        { id: 'c17', component: 'Column', children: ['c7', 'c8', 'c10', 'c11', 'c16'] },
        { id: 'trail_row_head', component: 'Text', text: { '@path': 'heading' } },
        {
          id: 'trail_row_sum',
          component: 'Text',
          text: { '@path': 'summary' },
          variant: 'caption',
        },
        { id: 'trail_row', component: 'Column', children: ['trail_row_head', 'trail_row_sum'] },
        { id: 'c18', component: 'List', children: { path: '/trail', componentId: 'trail_row' } },
        { id: 'c19', component: 'Text', text: 'Disk usage above 95%.' },
        {
          id: 'c20',
          component: 'Tabs',
          tabs: [
            { title: 'Diagnosis', child: 'c17' },
            { title: 'Evidence trail (2)', child: 'c18' },
            { title: 'Alert', child: 'c19' },
          ],
        },
        { id: 'c21', component: 'Column', children: ['c3', 'c4', 'c5', 'c6', 'c20'] },
        { id: 'root', component: 'Card', child: 'c21' },
      ],
      dataModel: {
        trail: [
          {
            heading: '**e1** prometheus_query — check usage',
            summary: 'node_filesystem_avail at 4%',
          },
          { heading: '**e2** kubectl_get — list pods (failed)', summary: 'forbidden' },
        ],
      },
    },
  },
];
