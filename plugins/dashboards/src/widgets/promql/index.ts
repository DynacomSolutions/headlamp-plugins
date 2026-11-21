import { breakdownWidget } from './BreakdownWidget';
import { gaugeWidget } from './GaugeWidget';
import { matrixWidget } from './MatrixWidget';
import { statWidget } from './StatWidget';
import { tableWidget } from './TableWidget';
import { timeSeriesWidget } from './TimeSeriesWidget';

/** The PromQL widgets. Register them with the other built-in widgets. */
export const PROMQL_WIDGETS = [
  timeSeriesWidget,
  statWidget,
  gaugeWidget,
  tableWidget,
  breakdownWidget,
  matrixWidget,
];
