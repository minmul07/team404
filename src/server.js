import http from 'node:http';
import fs from 'node:fs/promises';

// 1. 가짜 런타임 정의
const runtime = {
    async getSnapshot() {
        return {
            activeTarget: "/home/bangjyuhyeon/team404",
            quarantineJobs: [{ incidentId: "demo-001", rootPath: "/test", entryCount: 1 }]
        };
    }
};

// 2. 서버 생성
const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    // 대시보드 파일 서빙
    let filePath = '';
    if (url.pathname === '/' || url.pathname === '/index.html') filePath = './public/index.html';
    else if (url.pathname === '/style.css') filePath = './public/style.css';
    else if (url.pathname === '/app.js') filePath = './public/app.js';

    if (filePath) {
        try {
            const content = await fs.readFile(filePath);
            response.end(content);
            return;
        } catch (e) { }
    }

    // API 응답
    if (url.pathname === '/api/snapshot') {
        const data = await runtime.getSnapshot();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(data));
        return;
    }
});

server.listen(3000, '0.0.0.0', () => {
    console.log("서버 실행 중: http://localhost:3000");
});