#!/usr/bin/env node

import { QuadraAMcpServer } from './server.js';

const server = new QuadraAMcpServer();
server.start();
