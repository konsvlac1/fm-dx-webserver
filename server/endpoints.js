// Library imports
const express = require('express');
const router = express.Router();
const fs = require('fs');
const { SerialPort } = require('serialport')
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// File Imports
const { parseAudioDevice } = require('./stream/parser');
const { configName, serverConfig, configUpdate, configSave, configExists, configPath } = require('./server_config');
const helpers = require('./helpers');
const tunerProfiles = require('./tuner_profiles');
const storage = require('./storage');
const { logInfo, logDebug, logWarn, logError, logFfmpeg, logs } = require('./console');
const dataHandler = require('./datahandler');
const fmdxList = require('./fmdx_list');
const { allPluginConfigs } = require('./plugins');

// Endpoints
router.get('/', (req, res) => {
    const ban = helpers.isBanned(req);
    if (ban) {
        res.status(403).render('403', { reason: Array.isArray(ban) ? ban[3] : null });
        logInfo(`Web client (${helpers.getClientIp(req)}) is banned`);
        return;
    }

    const noPlugins = req.query.noPlugins === 'true';

    if (configExists() === false) {
        let serialPorts;
        
        SerialPort.list()
        .then((deviceList) => {
            serialPorts = deviceList.map(port => ({
                path: port.path,
                friendlyName: port.friendlyName,
            }));
            
            parseAudioDevice((result) => {
                res.render('wizard', {
                    isAdminAuthenticated: true,
                    videoDevices: result.audioDevices,
                    audioDevices: result.videoDevices,
                    serialPorts: serialPorts,
                    tunerProfiles: tunerProfiles.map((profile) => ({
                        id: profile.id,
                        label: profile.label,
                        detailsHtml: helpers.parseMarkdown(profile.details || '')
                    }))
                });
            });
        });
    } else {
            res.render('index', {
                isAdminAuthenticated: req.session.isAdminAuthenticated,
                isTuneAuthenticated: req.session.isTuneAuthenticated,
                tunerName: serverConfig.identification.tunerName,
                tunerDesc: helpers.parseMarkdown(serverConfig.identification.tunerDesc),
                tunerDescMeta: helpers.removeMarkdown(serverConfig.identification.tunerDesc),
                tunerLock: serverConfig.lockToAdmin,
                publicTuner: serverConfig.publicTuner,
                ownerContact: serverConfig.identification.contact,
                antennas: serverConfig.antennas,
                tuningLimit: serverConfig.webserver.tuningLimit,
                tuningLowerLimit: serverConfig.webserver.tuningLowerLimit,
                tuningUpperLimit: serverConfig.webserver.tuningUpperLimit,
                chatEnabled: serverConfig.webserver.chatEnabled,
                device: serverConfig.device,
                tunerProfiles,
                si47xxAgcControl: !!serverConfig.si47xx?.agcControl,
                noPlugins,
                plugins: serverConfig.plugins,
                fmlist_integration: serverConfig.extras.fmlistIntegration,
                fmlist_adminOnly: serverConfig.extras.fmlistAdminOnly,
                bwSwitch: serverConfig.bwSwitch
            });
    }
});

router.get('/403', (req, res) => {
    const reason = req.query.reason ? req.query.reason : null;
    res.render('403', { reason });
})

router.get('/wizard', (req, res) => {
    let serialPorts;
    
    if(!req.session.isAdminAuthenticated) {
        res.render('login');
        return;
    }

    SerialPort.list()
    .then((deviceList) => {
        serialPorts = deviceList.map(port => ({
            path: port.path,
            friendlyName: port.friendlyName,
        }));
        
        parseAudioDevice((result) => {
            res.render('wizard', {
                isAdminAuthenticated: req.session.isAdminAuthenticated,
                videoDevices: result.audioDevices,
                audioDevices: result.videoDevices,
                serialPorts: serialPorts,
                tunerProfiles: tunerProfiles.map((profile) => ({
                    id: profile.id,
                    label: profile.label,
                    detailsHtml: helpers.parseMarkdown(profile.details || '')
                }))
            });
        });
    })
})
  
  router.get('/setup', (req, res) => {
      let serialPorts; 
      function loadConfig() {
        if (fs.existsSync(configPath)) {
          const configFileContents = fs.readFileSync(configPath, 'utf8');
          return JSON.parse(configFileContents);
        }
        return serverConfig;
      }
  
      if(!req.session.isAdminAuthenticated) {
          res.render('login');
          return;
      }
      
      SerialPort.list()
      .then((deviceList) => {
          serialPorts = deviceList.map(port => ({
              path: port.path,
              friendlyName: port.friendlyName,
          }));
          
          parseAudioDevice((result) => {
              const processUptimeInSeconds = Math.floor(process.uptime());
              const formattedProcessUptime = helpers.formatUptime(processUptimeInSeconds);
              
              const updatedConfig = loadConfig();  // Reload the config every time
          res.render('setup', {
              isAdminAuthenticated: req.session.isAdminAuthenticated,
              videoDevices: result.audioDevices,
              audioDevices: result.videoDevices,
              serialPorts: serialPorts,
              memoryUsage: (process.memoryUsage.rss() / 1024 / 1024).toFixed(1) + ' MB',
              memoryHeap: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + ' MB',
              processUptime: formattedProcessUptime,
              plugins: allPluginConfigs,
              enabledPlugins: updatedConfig.plugins,
              onlineUsers: dataHandler.dataToSend.users,
              connectedUsers: storage.connectedUsers,
              connectionLog: connectionLogLines(),
              device: serverConfig.device,
              banlist: updatedConfig.webserver.banlist, // Updated banlist from the latest config
              tunerProfiles: tunerProfiles.map((profile) => ({
                  id: profile.id,
                  label: profile.label,
                  detailsHtml: helpers.parseMarkdown(profile.details || '')
              }))
          });
      });
  }) 
  });
  

router.get('/rds', (req, res) => {
    res.send('Please connect using a WebSocket compatible app to obtain RDS stream.');
});

router.get('/rdsspy', (req, res) => {
    res.send('Please connect using a WebSocket compatible app to obtain RDS stream.');
});

router.get('/api', (req, res) => {
    const { ps_errors, rt0_errors, rt1_errors, ims, eq, ant, st_forced, previousFreq, txInfo, rdsMode, ...dataToSend } = dataHandler.dataToSend;
    res.json({
        ...dataToSend,
        txInfo: txInfo,
        ps_errors: ps_errors,
        ant: ant,
        rbds: serverConfig.webserver.rdsMode
    });
});


const loginAttempts = {}; // Format: { 'ip': { count: 1, lastAttempt: 1234567890 } }
const MAX_ATTEMPTS = 25;
const WINDOW_MS = 15 * 60 * 1000;

// Compares without leaking through timing how much of the password was right
function samePassword(given, expected) {
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

// A password only matches when one is set: an empty tune or admin password is "no login", not
// "anyone who sends an empty password"
const passwordMatches = (given, expected) =>
    typeof given === 'string' && given.length > 0 && typeof expected === 'string' && expected.length > 0 && samePassword(given, expected);

const authenticate = (req, res, next) => {
    // The real visitor (behind a proxy, req.ip would be the proxy, so one person could lock everyone out)
    const ip = helpers.getClientIp(req) || req.socket.remoteAddress;
    const now = Date.now();

    for (const [k, v] of Object.entries(loginAttempts)) {
        if (now - v.lastAttempt > WINDOW_MS) delete loginAttempts[k];
    }
    if (!loginAttempts[ip]) {
        loginAttempts[ip] = { count: 0, lastAttempt: now };
    }

    if (loginAttempts[ip].count >= MAX_ATTEMPTS) {
        return res.status(403).json({
            message: 'Too many login attempts. Please try again later.'
        });
    }

    const { password } = req.body || {};

    loginAttempts[ip].lastAttempt = now;

    let role = null;
    if (passwordMatches(password, serverConfig.password.adminPass)) role = 'admin';
    else if (passwordMatches(password, serverConfig.password.tunePass)) role = 'tune';

    if (!role) {
        loginAttempts[ip].count += 1;
        return res.status(403).json({ message: 'Login failed. Wrong password?' });
    }

    // A new session id at login, so an id someone knew before can't be used afterwards
    req.session.regenerate((err) => {
        if (err) return res.status(500).json({ message: 'Login failed, please try again.' });
        req.session.isAdminAuthenticated = role === 'admin';
        req.session.isTuneAuthenticated = true;
        logInfo(`User from ${ip} logged in ${role === 'admin' ? 'as an administrator' : 'with tune permissions'}.`);
        delete loginAttempts[ip];
        next();
    });
};

// Admin actions must come from this server's own pages: a page on another website can't make a
// logged-in admin's browser kick, ban, restart or change settings (cross-site request forgery).
// The browser sends Origin with POST and Referer with same-site GET; both name the page it came from.
function fromOwnPage(req) {
    const from = req.headers.origin || req.headers.referer;
    if (!from) return false;
    let host;
    try { host = new URL(from).host.toLowerCase(); } catch (e) { return false; }
    const own = [req.headers['x-forwarded-host'], req.headers.host]
        .filter(Boolean).map(h => String(h).split(',')[0].trim().toLowerCase());
    return own.includes(host);
}

function ownPageOnly(req, res, next) {
    if (fromOwnPage(req)) return next();
    logWarn(`Blocked an admin request to ${req.path} that did not come from this server's pages (${helpers.getClientIp(req)}).`);
    res.status(403).json({ success: false, message: 'This request must come from the server\'s own page.' });
}

// Route for login
router.post('/login', authenticate, (req, res) => {
    // Redirect to the main page after successful login
    res.status(200).json({ message: 'Logged in successfully, refreshing the page...' });
});

router.get('/logout', (req, res) => {
    // Clear the session and redirect to the main page
    req.session.destroy(() => {
        res.status(200).json({ message: 'Logged out successfully, refreshing the page...' });
    });
});

router.get('/kick', (req, res) => {
    const ipAddress = req.query.ip; // Extract the IP address parameter from the query string
    // Terminate the WebSocket connection for the specified IP address
    if (req.session.isAdminAuthenticated && fromOwnPage(req)) {
        helpers.kickClient(ipAddress);
    }
    setTimeout(() => {
        res.redirect('/setup');
    }, 500);
});

router.get('/console', (req, res) => {
    if (!req.session.isAdminAuthenticated) return res.status(403).end();
    res.json(logs);
});

const connectionLogLines = () => {
    const fmt = (ts) => ts ? new Date(ts).toLocaleString() : 'online';
    return storage.connectionLog.map(e => `[${fmt(e.connected)} → ${fmt(e.disconnected)}] ${e.ip} - ${e.location}`);
};

router.get('/connectionlog.txt', (req, res) => {
    if (!req.session.isAdminAuthenticated) return res.status(403).end();
    res.attachment('connection-log.txt').type('text/plain; charset=utf-8').send(connectionLogLines().join('\n'));
});

router.post('/restart', ownPageOnly, (req, res) => {
    if (!req.session.isAdminAuthenticated) return res.status(403).end();

    logInfo('Server restart requested from the admin panel.');
    res.json({ success: true });
    // 75 = restart code, index.js starts the server again
    setTimeout(() => process.exit(75), 500);
});

router.get('/addToBanlist', ownPageOnly, (req, res) => {
    if (!req.session.isAdminAuthenticated) return res.status(403).json({ success: false, message: 'Admin login required.' });

    const ipAddress = String(req.query.ip || '').replace(/\s+/g, '');
    if (!ipAddress) return res.status(400).json({ success: false, message: 'No IP address given.' });
    const location = 'Unknown';
    const date = Date.now();
    const reason = req.query.reason === undefined ? undefined : String(req.query.reason).slice(0, 500);

    const userBanData = [ipAddress, location, date, reason];

    if (typeof serverConfig.webserver.banlist !== 'object') {
        serverConfig.webserver.banlist = [];
    }

    serverConfig.webserver.banlist.push(userBanData);
    configSave();
    res.json({ success: true, message: 'IP address added to banlist.' });
    helpers.kickClient(ipAddress);
});

router.get('/removeFromBanlist', ownPageOnly, (req, res) => {
    if (!req.session.isAdminAuthenticated) return res.status(403).json({ success: false, message: 'Admin login required.' });

    const ipAddress = req.query.ip;

    if (typeof serverConfig.webserver.banlist !== 'object') {
        serverConfig.webserver.banlist = [];
    }

    const banIndex = serverConfig.webserver.banlist.findIndex(ban => ban[0] === ipAddress);

    if (banIndex === -1) {
        return res.status(404).json({ success: false, message: 'IP address not found in banlist.' });
    }

    serverConfig.webserver.banlist.splice(banIndex, 1);
    configSave();

    res.json({ success: true, message: 'IP address removed from banlist.' });
});


router.post('/saveData', ownPageOnly, (req, res) => {
    const data = req.body;
    let firstSetup;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).send('Invalid settings.');
    }
    if(req.session.isAdminAuthenticated || configExists() === false) {
        configUpdate(data);
        fmdxList.update();
        
        if(configExists() === false) {
            firstSetup = true;
        }
        logInfo('Server config changed successfully.');
        if(firstSetup === true) {
            res.status(200).send('Data saved successfully!\nPlease, restart the server to load your configuration.');
        } else {
            res.status(200).send('Data saved successfully!\nSome settings may need a server restart to apply.');
        }
    } else {
        res.status(403).send('Admin login required.');
    }
});

router.get('/getData', (req, res) => {  
    if (configExists() === false) {
        return res.json(serverConfig);
    }
    
    if (!req.session.isAdminAuthenticated) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    {
        // Check if the file exists
        fs.access(configPath, fs.constants.F_OK, (err) => {
            if (err) {
                console.log(err);
            } else {
                // File exists, send it as the response
                res.sendFile(path.join(__dirname, '../' + configName + '.json'));
            }
        });
    }
});

router.get('/getDevices', (req, res) => {
    if (req.session.isAdminAuthenticated || !fs.existsSync(configName + '.json')) {
        parseAudioDevice((result) => {
            res.json(result);
        });
    } else {
        res.status(403).json({ error: 'Unauthorized' });
    }
});

/* Static data are being sent through here on connection - these don't change when the server is running */
router.get('/static_data', (req, res) => {
    res.json({
        qthLatitude: serverConfig.identification.lat,
        qthLongitude: serverConfig.identification.lon,
        presets: serverConfig.webserver.presets || [],
        defaultTheme: serverConfig.webserver.defaultTheme || 'theme1',
        bgImage: serverConfig.webserver.bgImage || '',
        rdsMode: serverConfig.webserver.rdsMode || false,
        rdsTimeout: serverConfig.webserver.rdsTimeout || 0,
        tunerName: serverConfig.identification.tunerName || '',
        tunerDesc: serverConfig.identification.tunerDesc || '',
        ant: serverConfig.antennas || {}
    });
});

router.get('/server_time', (req, res) => {
    res.json({
        serverTime: new Date(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
});

router.get('/ping', (req, res) => {
    res.send('pong');
});  

const logHistory = {};

// Function to check if the ID has been logged within the last 60 minutes
function canLog(id) {
    const now = Date.now();
    const sixtyMinutes = 60 * 60 * 1000; // 60 minutes in milliseconds
    
    // Remove expired entries
    for (const [entryId, timestamp] of Object.entries(logHistory)) {
        if ((now - timestamp) >= sixtyMinutes) {
            delete logHistory[entryId];
        }
    }
    
    if (logHistory[id] && (now - logHistory[id]) < sixtyMinutes) {
        return false; // Deny logging if less than 60 minutes have passed
    }
    logHistory[id] = now; // Update with the current timestamp
    return true;
}

router.get('/log_fmlist', (req, res) => {
    if (dataHandler.dataToSend.txInfo.tx.length === 0) {
        res.status(500).send('No suitable transmitter to log.');
        return;
    }

    if (serverConfig.extras.fmlistIntegration === false || (serverConfig.extras.fmlistAdminOnly && !req.session.isTuneAuthenticated)) {
        res.status(500).send('FMLIST Integration is not available.');
        return;
    }

    const clientIp = helpers.getClientIp(req);
    const txId = dataHandler.dataToSend.txInfo.id; // Extract the ID

    if (!canLog(txId)) {
        res.status(429).send(`ID ${txId} was already logged recently. Please wait before logging again.`);
        return;
    }

    const postData = JSON.stringify({
        station: {
            freq: dataHandler.dataToSend.freq,
            pi: dataHandler.dataToSend.pi,
            id: dataHandler.dataToSend.txInfo.id,
            rds_ps: dataHandler.dataToSend.ps.replace(/'/g, "\\'"), // Escape quotes
            signal: dataHandler.dataToSend.sig,
            tp: dataHandler.dataToSend.tp,
            ta: dataHandler.dataToSend.ta,
            af_list: dataHandler.dataToSend.af,
        },
        server: {
            uuid: serverConfig.identification.token,
            latitude: serverConfig.identification.lat,
            longitude: serverConfig.identification.lon,
            address: serverConfig.identification.proxyIp.length > 1 ? serverConfig.identification.proxyIp : ('Matches request IP with port ' + serverConfig.webserver.port),
            webserver_name: serverConfig.identification.tunerName.replace(/'/g, "\\'"), // Escape quotes
            omid: serverConfig.extras?.fmlistOmid || '',
        },
        client: {
            request_ip: clientIp
        },
        type: (req.query.type && dataHandler.dataToSend.txInfo.dist > 700) ? req.query.type : 'tropo',
        log_msg: "Logged PS: " + dataHandler.dataToSend.ps.replace(/\s+/g, '_') + ", PI: " + dataHandler.dataToSend.pi + ", Signal: " + (dataHandler.dataToSend.sig - 11.25).toFixed(0) + " dBµV",
    });

    const options = {
        hostname: 'api.fmlist.org',
        path: '/fmdx.org/slog.php',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData) // Use Buffer.byteLength for accurate content length
        }
    };

    const request = https.request(options, (response) => {
        let data = '';

        // Collect response chunks
        response.on('data', (chunk) => {
            data += chunk;
        });

        // Response ended
        response.on('end', () => {
            res.status(200).send(data);
        });
    });

    // Handle errors in the request
    request.on('error', (error) => {
        console.error('Error sending POST request:', error);
        res.status(500).send(error.message); // Send error message to client
    });

    // Write the postData and end the request properly
    request.write(postData);
    request.end();
});

router.get('/tunnelservers', async (req, res) => {
    const servers = [
      { value: "eu", host: "eu.fmtuner.org", label: "Europe" },
      { value: "us", host: "us.fmtuner.org", label: "Americas" },
      { value: "sg", host: "sg.fmtuner.org", label: "Asia & Oceania" },
    ];
  
    const results = await Promise.all(
      servers.map(async s => {
        const latency = await helpers.checkLatency(s.host);
        return {
          value: s.value,
          label: `${s.label} (${latency ? latency + ' ms' : 'offline'})` // From my tests, the latency via HTTP ping is roughly 2x higher than regular ping
        };
      })
    );
  
    res.json(results);
  });

module.exports = router;
