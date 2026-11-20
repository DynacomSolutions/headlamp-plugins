import Typography from '@mui/material/Typography';
import React from 'react';

/** A widget that throws shows a message in its own card and leaves the rest of the dashboard alone. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
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
