import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { app } from './app.ts';
import { controlRpcHandler } from './orpc.ts';

export type ApiServerOptions = {
  hostname?: string;
  port?: number;
  onListening?: (address: AddressInfo) => void;
};

export function createApiServer(options: ApiServerOptions = {}): ServerType {
  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on('connection', (socket, request) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname === '/v1/control') {
      void controlRpcHandler.upgrade(socket);
    }
  });

  return serve(
    {
      fetch: app.fetch,
      hostname: options.hostname ?? '0.0.0.0',
      port: options.port ?? 8787,
      websocket: { server: websocketServer },
    },
    options.onListening,
  );
}
