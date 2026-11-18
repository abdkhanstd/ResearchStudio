/*! Research Studio — Copyright (c) 2026 Abdullah Aman Khan. All rights reserved.
 *  Source available under the Research Studio Personal Use License (see LICENSE): personal, non-commercial use only.
 *  Copying, redistribution, modification and use in other projects are not permitted. */
// Local development: no .env needed, data in var/, emails written to var/outbox instead of being sent.
process.env.DEV_MODE = '1';
process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:4150';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-secret-development-only-secret';
process.env.MAIL_MODE = process.env.MAIL_MODE || 'file';
require('../server.js');
