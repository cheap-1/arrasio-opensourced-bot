// Log startup messages
console.log("Starting up...");
console.log("Importing modules...\n");

const path = require("path");
const fs = require("fs");
const http = require("http");
const url = require("url");
const pjson = require("../package.json")

const { Worker } = require("worker_threads");
const { WebSocket } = require("ws");

// Increase the stack trace limit for better debugging
Error.stackTraceLimit = Infinity;

// Load environment variables from .env using a custom dotenv loader
const dotenv = require("./lib/dotenv.js");
const envContent = fs.readFileSync(path.join(__dirname, "./.env")).toString();
const environment = dotenv(envContent);

// Set each environment variable in process.env
for (const key in environment) {
    process.env[key] = environment[key];
}

// Load all necessary modules and files via the loader
const GLOBAL = require("./loaders/loader.js");

// Load definitions and tile definitions
new definitionCombiner(
    {
        groups: path.join(__dirname, "./lib/definitions/groups"),
        addonsFolder: path.join(__dirname, "./lib/definitions/entityAddons")
    }
).loadDefinitions();
GLOBAL.loadRooms(true);

// Optionally load all mockups if enabled in configuration
if (Config.load_all_mockups) global.loadAllMockups();

// Log loader information including creation date and time
console.log("Successfully loaded all files.");
console.log(`Created on date ${GLOBAL.creationDate} at timestamp ${GLOBAL.creationTime}`);

// Define the public directory for static files
const publicRoot = path.join(__dirname, "../public/"),
    mimeSet = {
        js: "application/javascript",
        json: "application/json",
        css: "text/css",
        html: "text/html",
        md: "text/markdown",
        png: "image/png",
        svg: "image/svg+xml"
    };

let wsServer; // WebSocket server instance
let server; // HTTP server instance

// Attempt to create a WebSocket server instance using the 'ws' package
try {
    const WebSocketServer = require("ws").WebSocketServer;
    wsServer = new WebSocketServer({
        noServer: true,
        perMessageDeflate: !!Config.enable_websocket_compression && {
            threshold: Config.websocket_compression_threshold,
            zlibDeflateOptions: { level: 1 }
        }
    });
} catch(err) {
    throw new Error(
        "Package 'ws' is not installed! To install it, run 'npm install ws' in the terminal."
    );
}

// Log a warning if Access-Control-Allow-Origin is enabled
if (Config.allow_ACAO && Config.startup_logs) {
    util.warn("Access-Control-Allow-Origin is enabled, which allows any server/client to access data from the WebServer.");
}

/* ---------------------------------------------------------------------------
 * Game server proxy.
 *
 * Every game server normally listens on its own port. When only the main port
 * is reachable (for example behind a Cloudflare Tunnel, a reverse proxy or a
 * firewall) nobody else can join those servers because the client is told to
 * connect to "localhost:3001" and friends.
 *
 * The main server can therefore act as a WebSocket proxy: a client connects to
 * "wss://<main host>/<server id>" and the connection is forwarded to the game
 * server running on that id. The address that is published to clients is
 * picked automatically, so a server reached through a tunnel keeps working for
 * remote players while local players can still connect directly.
 * ------------------------------------------------------------------------ */

// The host the client used to reach the main server (may be a tunnel hostname).
const getRequestHost = req => req.headers.host || Config.host;

// Should the clients be pointed at the proxy instead of the game server ports?
const shouldProxy = (requestHost, mode = Config.proxy_game_servers) => {
    if (mode === true) return true;
    if (mode === false) return false;
    // "auto": only proxy when the main server is reached through another host
    // (a tunnel or a reverse proxy), otherwise the game server ports are usable.
    return requestHost !== Config.host;
};

// The address a client should use to reach a given game server.
const getPublicServerAddress = (server, requestHost) => {
    if (!server) return requestHost || Config.host;
    if (!shouldProxy(requestHost)) return server.ip;
    const host = requestHost || Config.host;
    if (server.gameManager) return host; // The sandbox runs inside the main server.
    return `${host}/${server.id}`;
};

// Forward a WebSocket connection to a game server running on this machine.
const proxyGameServer = (req, socket, head, target, upstreamPath) => {
    const clientIp = req.headers["cf-connecting-ip"] ||
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.headers["x-real-ip"] ||
        (req.socket && req.socket.remoteAddress);
    const headers = {};
    if (clientIp) headers["x-forwarded-for"] = clientIp;
    // Keep the host the player actually connected through (a tunnel hostname, for
    // example). The game server needs it to send the player back to an address
    // they can actually reach when they travel to another server.
    const originalHost = req.headers.host;
    if (originalHost) {
        headers["host"] = originalHost;
        headers["x-forwarded-host"] = originalHost;
    }
    let upstream;
    try {
        upstream = new WebSocket(`ws://127.0.0.1:${target.port}${upstreamPath}`, {
            headers,
            // The payload is already compressed on the client side, so don't
            // compress it a second time on the local hop.
            perMessageDeflate: false
        });
    } catch (e) {
        try { socket.destroy(); } catch {}
        return;
    }
    upstream.binaryType = "arraybuffer";
    const abort = () => { try { socket.destroy(); } catch {} };
    upstream.once("open", () => {
        wsServer.handleUpgrade(req, socket, head, ws => {
            ws.on("message", (data, isBinary) => {
                if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
            });
            upstream.on("message", (data, isBinary) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
            });
            const closeBoth = () => {
                try { upstream.close(); } catch {}
                try { ws.close(); } catch {}
            };
            ws.on("close", closeBoth);
            ws.on("error", closeBoth);
            upstream.on("close", () => { try { ws.close(); } catch {} });
            upstream.on("error", () => { try { ws.close(); } catch {} });
        });
    });
    upstream.once("error", abort);
    socket.on("error", abort);
};

// Create an HTTP server to handle both API and static file requests
server = http.createServer((req, res) => {
    let query = {};
    let pathname = req.url.split("?")[0];
    if (req.url.includes("?")) {
        req.url.split("?")[1].split("&").map(i => {
            let key = i.split("=")[0];
            let value = i.split("=")[1];
            query[key] = value;
        }); 
    }
    let readString = ""; // Response content for API endpoints
    let ok = true; // Flag to indicate whether we use default API response
    let serversIP = [];
    let clientHeaders = ["/ext/custom-shape", "/ext/editor"];
    let selectedHeader = null;

    // Set CORS headers if enabled in the configuration or allow only the children servers.
    for (let server of global.servers) {
        if (server.ip !== Config.host && server.ip) {
            let http = server.ip.startsWith("localhost") ? `http://${server.ip}` : `https://${server.ip}`;
            serversIP.push(http);
        }
    };
    // The host the client used to reach us is always allowed to talk to us.
    if (req.headers.host) {
        serversIP.push(`http://${req.headers.host}`);
        serversIP.push(`https://${req.headers.host}`);
    }
    if (Config.allow_ACAO || serversIP.includes(req.headers.origin)) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    for (let i = 0; i < clientHeaders.length; i++) {
        if (clientHeaders[i] == req.url) {
            selectedHeader = clientHeaders[i];
        }
    }
    // Handle specific API endpoints based on the request URL
    switch (pathname) {
        case "/getServers.json": {
            // Serve a list of active servers (excluding hidden ones)
            const requestHost = getRequestHost(req);
            readString = JSON.stringify(servers.filter((s) => s && !s.hidden).map((server) => ({
                ip: getPublicServerAddress(server, requestHost),
                players: server.players,
                maxPlayers: server.maxPlayers,
                id: server.id,
                featured: server.featured,
                unlisted: server.unlisted,
                private: server.private,
                region: server.region,
                serverhost: server.serverhost,
                location: server.location,
                gameMode: server.gameMode
            })));
        } break;
        case "/getTotalPlayers": {
            let countPlayers = 0;
            servers.forEach((s) => {
                countPlayers += s.players;
            });
            readString = JSON.stringify(countPlayers);
        } break;
        case "/version": {
            readString = JSON.stringify({ver: "v" + pjson.version, dev_build: Config.dev_build});
        } break;
        
        case "/api/getAddonAuthors": {
            if (!query.token || query.token !== process.env.DEVELOPER) {
                res.writeHead(403);
                res.end("Forbidden");
                return;
            }
            readString = JSON.stringify(global.addonAuthorInfos);
        } break;

        case "/api/sendPlayer": {
            ok = false;
            if (query.api_key !== process.env.API_KEY) {
                res.writeHead(403);
                res.end("Access Denied");
                return;
            }
            let body = "";
            req.on("data", c => body += c);
            req.on("end", () => {
                let json = null;
                try {
                    json = JSON.parse(body);
                } catch { }
                if (json) {
                    let { id, name, definition, score, level, skillcap, skill, points, killCount } = json;
                    global.travellingPlayers.push({ id, name, definition, score, level, skillcap, skill, points, killCount });
                    res.writeHead(200);
                    res.end("OK");
                } else {
                    res.writeHead(400);
                    res.end("Invalid JSON body");
                }
            });
        } break;
        case "/portalPermission": {
            ok = false;
            let sserver = [];
            if (Config.allow_server_travel && global.launchedOnMainServer) {
                const requestHost = getRequestHost(req);
                for (let i = 0; i < global.servers.length; i++) {
                    let server = global.servers[i];
                    if (server.gameManager) sserver.push(server);
                }
                res.writeHead(200);
                res.end(JSON.stringify(sserver.map((server) => ({
                    ip: server.ip,
                    publicIp: getPublicServerAddress(server, requestHost),
                    id: server.id,
                    players: server.players,
                    gameMode: server.gameMode
                }))));
            } else {
                res.writeHead(404);
                res.end("Denied.");
            }
        } break;
        case "/isOnline": {
            readString = "true";
        } break;
        case selectedHeader: {
            // For all other routes, serve static files from the public directory
            ok = false;
            let fileToGet = path.join(publicRoot, req.url);

            // If the requested file doesn't exist or isn't a file, default to the INDEX_HTML file
            if (!fs.existsSync(fileToGet) || !fs.lstatSync(fileToGet).isFile()) {
                fileToGet = path.join(publicRoot, `${selectedHeader}/index.html`);
            }

            // Determine the file's MIME type based on its extension and serve the file stream
            const extension = fileToGet.split(".").pop();
            res.writeHead(200, { "Content-Type": mimeSet[extension] || "text/html" });
            fs.createReadStream(fileToGet).pipe(res);
        } break;

        default: {
            // For all other routes, serve static files from the public directory
            ok = false;
            let fileToGet = path.join(publicRoot, pathname);
            let httpCode = 200;

            // If the requested file doesn't exist or isn't a file, default to the main_menu file
            if (!fileToGet.startsWith(publicRoot) || !fs.existsSync(fileToGet) || !fs.lstatSync(fileToGet).isFile()) {
                httpCode = 404;
                fileToGet = path.join(publicRoot, Config.main_menu);
            }

            // Determine the file's MIME type based on its extension and serve the file stream
            const extension = fileToGet.split(".").pop();
            res.writeHead(httpCode, { "Content-Type": mimeSet[extension] || "text/html" });
            fs.createReadStream(fileToGet).pipe(res);
        } break;
    }

    // If an API endpoint was handled, send the JSON response
    if (ok) {
        res.writeHead(200);
        res.end(readString);
    }
});

// Loads a game server
function loadGameServer(loadViaMain = false, host, port, gamemode, region, serverHost, location, webProperties, properties, isFeatured, isUnlisted, isPrivate) {
    // Determine the new server index and initialize an empty object in the global servers array
    if (!loadViaMain) {
        let index = global.servers.length;
        global.servers.push({});

        // Create a new worker thread to load the game server asynchronously
        let worker = new Worker("./server/serverLoader.js", {
            workerData: {
                host,
                port: port, // Increment port for each server
                gamemode,
                region,
                serverHost,
                location,
                webProperties,
                properties,
                isFeatured,
                isUnlisted,
                isPrivate,
                index
            }
        });

        // Listen for messages from the worker to update the server's status
        worker.on("message", message => {
            const flag = message.shift();
            switch (flag) {
                case false:
                    // Initial load: store server details
                    global.servers[index] = message.shift();
                    break;
                case true:
                    // Update: change the server's player count
                    global.servers[index].players = message.shift();
                    break;
                case "doneLoading":
                    // Once loading is complete, trigger the server loaded callback
                    onServerLoaded();
                    break;
            }
        });
    } else {
        global.servers.push({ loadedViaMainServer: true });
        setTimeout(() => { // Space it a little out.
            if (global.launchedOnMainServer) {
                console.warn("Only one server can be loaded via through the main server!\nProcess terminated.");
                process.exit(1);
            }
            global.launchedOnMainServer = true;
            new (require("./game.js").gameServer)(Config.host, Config.port, gamemode, region, serverHost, location, webProperties, properties, isFeatured, isUnlisted, isPrivate, false);
        }, 10)
    }
}

// Server Loaded Callback
let loadedServers = 0;
global.onServerLoaded = () => {
    loadedServers++;
    // Once all servers are loaded, log the status and routing table
    if (loadedServers >= global.servers.length) {
        util.saveToLog("Servers up", "All servers booted up.", 0x37F554);
        if (Config.startup_logs) {
            util.log("Dumping endpoint -> gamemode/region routing table");
            for (const game of global.servers) {
                console.log(`> ${Config.host}/#${game.id}`.padEnd(30, " ") + ` -> ${game.region.padEnd(10, " ")} (${game.serverhost.padEnd(8, " ")} - ${game.location.padEnd(10, " ")} - ${game.gameMode})`)
            }
            console.log("\n");
        }
        let serverStartEndTime = performance.now();
        console.log(`Server loaded in ${util.rounder(serverStartEndTime, 4)} milliseconds.`);
        console.log(`[WEB SERVER]: Server listening on port ${Config.port}`);
    }
};

// Start the HTTP Server & Load Game Servers
server.listen(Config.port, () => {
    Config.servers.forEach(server => {
    // Load all of the servers.
        loadGameServer(
            server.share_client_server,
            server.host,
            server.port,
            server.gamemode,
            server.region,
            server.serverhost,
            server.location,
            { id: server.id, maxPlayers: server.player_cap },
            server.properties,
            server.featured,
            server.unlisted,
            server.private
        );
    })
});

// Upgrade HTTP connections to WebSocket connections if applicable
server.on("upgrade", (req, socket, head) => {
    // A path like "/la" or "/la/api/editor" targets a specific game server.
    // Forward those connections to that server so players only need the main port.
    const rawUrl = req.url || "/";
    const queryIndex = rawUrl.indexOf("?");
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex);
    const segments = rawPath.split("/").filter(Boolean);
    if (segments.length) {
        const target = global.servers.find(s => s && s.id === segments[0]);
        if (target && !target.gameManager && target.port && target.port !== Config.port) {
            const rest = segments.slice(1).join("/");
            proxyGameServer(req, socket, head, target, (rest ? "/" + rest : "/") + query);
            return;
        }
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
        if (global.launchedOnMainServer) {
            for (let i = 0; i < global.servers.length; i++) {
                let server = global.servers[i];
                if (server.gameManager) server.gameManager.socketManager.connect(ws, req);
            }
        } else {
            ws.close();
        }
    });
});

// Set up a loop to periodically call Bun's garbage collector if available
let bunLoop = setInterval(() => {
    try {
        Bun.gc(true);
    } catch(e) {
    // If Bun.gc fails, clear the interval
        clearInterval(bunLoop);
    }
}, 1000);

// Log that the web server has been initialized if logging is enabled
if (Config.startup_logs) console.log("Web Server initialized.");
