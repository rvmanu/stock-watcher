var Service = require('node-windows').Service;

// Create a new service object
var svc = new Service({
  name: 'Stock Watcher Service',
  description: 'Send notifications about the stock price changes',
  script: 'E:\\StockWatcher\\monitor.js'
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install',function() {
  svc.start();
});

svc.install();