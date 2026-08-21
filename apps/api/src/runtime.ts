import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { createApiApp } from './app.ts';
import type { Database } from './database/client.ts';
import { createControlRpcHandler } from './orpc.ts';
import { ServerEventBroker } from './server-events.ts';

export type ApiServerOptions = {
  app?: Hono;
  database?: Database;
  hostname?: string;
  port?: number;
  onListening?: (address: AddressInfo) => void;
  serverEvents?: ServerEventBroker;
};

export function createApiServer(options: ApiServerOptions = {}): ServerType {
  const serverEvents = options.serverEvents ?? new ServerEventBroker();
  const controlRpcHandler = createControlRpcHandler({
    database: options.database,
    serverEvents,
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on('connection', (socket, request) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/v1/control') {
      void controlRpcHandler.upgrade(socket);
    }
  });

  return serve(
    {
      fetch: options.app?.fetch ?? createApiApp({ serverEvents }).fetch,
      hostname: options.hostname ?? '0.0.0.0',
      port: options.port ?? 8787,
      websocket: { server: websocketServer },
    },
    options.onListening,
  );
}
