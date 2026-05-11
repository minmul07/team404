import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../app/runtime.js';

const PORT = 3000;
const HOST = '0.0.0.0';

// 함수 이름을 src/server.js와 맞춰서 export 합니다.
export function createServer(runtime) {
    return http.createServer(async (request, response) => {
        const url = new URL(request.url, `http://${request.headers.host}`);

        // [1] 대시보드 정적 파일 처리 (HTML, CSS, JS)
        let filePath = '';
        if (url.pathname === '/' || url.pathname === '/index.html') {
            filePath = './public/index.html';
        } else if (url.pathname === '/style.css') {
            filePath = './public/style.css';
        } else if (url.pathname === '/app.js') {
            filePath = './public/app.js';
        }

        if (filePath) {
            try {
                const content = await fs.readFile(filePath);
                const contentType = filePath.endsWith('.html') ? 'text/html' : 
                                  filePath.endsWith('.css') ? 'text/css' : 'application/javascript';
                response.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
                return response.end(content);
            } catch (err) {
                return writeJson(response, 404, { error: `파일을 찾을 수 없습니다: ${filePath}` });
            }
        }

        // [2] API 경로 처리 (대시보드 app.js에서 호출하는 경로)
        if (url.pathname === '/api/snapshot') {
            try {
                const data = await runtime.getSnapshot();
                return writeJson(response, 200, data);
            } catch (error) {
                return writeJson(response, 500, { error: error.message });
            }
        }

        // [3] 복구 API
        const restoreMatch = request.method === 'POST' && url.pathname.match(/^\/api\/incidents\/([^/]+)\/restore$/);
        if (restoreMatch) {
            const incidentId = restoreMatch[1];
            try {
                const result = await runtime.restoreIncident(incidentId);
                return writeJson(response, 200, result);
            } catch (error) {
                return writeJson(response, 500, { error: error.message });
            }
        }

        return writeJson(response, 404, { error: 'Not Found' });
    });
}

function writeJson(response, statusCode, payload) {
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload, null, 2));
}