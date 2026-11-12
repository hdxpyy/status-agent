import 'dotenv/config';
import si from 'systeminformation';

const STATUS_SERVER_URL = process.env.STATUS_SERVER_URL || 'http://localhost:3000';
const NODE_ID = process.env.NODE_ID;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const INTERVAL_MS = parseInt(process.env.AGENT_INTERVAL || '15000', 10);

if (!NODE_ID || !AGENT_TOKEN) {
  console.error('❌ Missing NODE_ID or AGENT_TOKEN in .env');
  process.exit(1);
}

console.log(`Starting Altrax Agent for Node: ${NODE_ID}`);
console.log(`Reporting to: ${STATUS_SERVER_URL}`);

// Helper to make authenticated requests to the status server
async function post(endpoint, data) {
  try {
    const res = await fetch(`${STATUS_SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGENT_TOKEN}`
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ API Error [${res.status}] ${endpoint}:`, text);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`❌ Network Error [${endpoint}]:`, err.message);
    return false;
  }
}

async function collectAndSend() {
  try {
    // Collect hardware data using systeminformation
    const [load, mem, fsSize, netStats, osInfo, cpu] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.osInfo(),
      si.cpu()
    ]);

    // Disk: Find root filesystem (or C: on Windows)
    const rootFs = fsSize.find(f => f.mount === '/' || f.mount === 'C:') || fsSize[0];
    
    // Network: Sum up all non-loopback interfaces
    let rxBytesSec = 0;
    let txBytesSec = 0;
    netStats.forEach(n => {
      if (n.iface !== 'lo' && !n.iface.includes('Loopback')) {
        rxBytesSec += (n.rx_sec || 0);
        txBytesSec += (n.tx_sec || 0);
      }
    });

    const metrics = {
      cpu: {
        model: `${cpu.manufacturer} ${cpu.brand}`,
        cores: cpu.cores,
        percent: load.currentLoad,
        load1: load.avgLoad,
        load5: 0, // Requires different OS call
        load15: 0,
      },
      ram: {
        total: mem.total / (1024 * 1024),
        used: mem.active / (1024 * 1024),
        percent: (mem.active / mem.total) * 100,
      },
      disk: {
        total: rootFs ? rootFs.size / (1024 * 1024 * 1024) : 0,
        used: rootFs ? rootFs.used / (1024 * 1024 * 1024) : 0,
        percent: rootFs ? rootFs.use : 0,
      },
      network: {
        rxMbps: (rxBytesSec * 8) / (1024 * 1024),
        txMbps: (txBytesSec * 8) / (1024 * 1024),
      },
      system: {
        os: `${osInfo.distro} ${osInfo.release}`,
        kernel: osInfo.kernel,
        uptime: si.time().uptime,
      }
    };

    // Send heartbeat
    await post('/api/agent/heartbeat', { nodeId: NODE_ID, agentVersion: '1.0.0' });
    
    // Send metrics
    await post('/api/agent/metrics', { nodeId: NODE_ID, metrics });
    
    console.log(`[${new Date().toLocaleTimeString()}] Sent metrics: CPU ${metrics.cpu.percent.toFixed(1)}%, RAM ${metrics.ram.percent.toFixed(1)}%`);

  } catch (err) {
    console.error('❌ Failed to collect system info:', err);
  }
}

// Run immediately, then on interval
collectAndSend();
setInterval(collectAndSend, INTERVAL_MS);
