import React from 'react';
import { Connection, ConnectionState, getConnection } from './connection';

/**
 * The state of the link to the server. The first mounted caller starts the probe loop and the
 * chunk error listeners, and the last one to unmount stops them. A test can pass its own connection.
 */
export function useConnection(connection: Connection = getConnection()): ConnectionState {
  React.useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, [connection]);
  return React.useSyncExternalStore(connection.subscribe, connection.getState);
}
