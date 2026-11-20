import Typography from '@mui/material/Typography';
import React from 'react';

interface Props {
  children: React.ReactNode;
  /** The widget id and its config. When it changes, a failed widget gets a new try. */
  resetKey?: string;
}
interface State {
  error?: Error;
  resetKey?: string;
}

/** A widget that throws shows a message in its own card and leaves the rest of the dashboard alone. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.resetKey !== state.resetKey
      ? { error: undefined, resetKey: props.resetKey }
      : null;
  }

  render() {
    if (this.state.error) {
      return (
        <Typography variant="body2" color="error" role="alert" sx={{ p: 1 }}>
          This widget failed: {this.state.error.message}
        </Typography>
      );
    }
    return this.props.children;
  }
}
