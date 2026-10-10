const { app, ipcMain, BrowserWindow, screen, shell, crashReporter  } = require("electron");
const remote = require("@electron/remote/main");
const fs = require("graceful-fs");
const path = require("path");
const os = require("os");
const url = require("url");
const { loadPresets, savePreset, deletePreset } = require("./presets");
const NotificationService = require('./notification-service');
require("events").EventEmitter.defaultMaxListeners = 30;

app.on('render-process-gone', (event, webContents, details) => { console.error('Render process gone:', event, webContents, details); });

remote.initialize();

app.commandLine.appendSwitch("--enable-precise-memory-info");
crashReporter.start({ uploadToServer : false });
console.log(crashReporter.getLastCrashReport());

/*
// main menu for mac
const template = [
{
    label: 'Deepnest',
    submenu: [
      {
        role: 'about'
      },
      {
        type: 'separator'
      },
      {
        role: 'services',
        submenu: []
      },
      {
        type: 'separator'
      },
      {
        role: 'hide'
      },
      {
        role: 'hideothers'
      },
      {
        role: 'unhide'
      },
      {
        type: 'separator'
      },
      {
        role: 'quit'
      }
    ]
  }
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
*/

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow = null;
let notificationWindow = null;
var backgroundWindows = [];
const notificationService = new NotificationService();

// single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Create myWindow, load the rest of the app, etc...
  app.whenReady().then(() => {
    //myWindow = createWindow()
  });
}

function createMainWindow() {
  // Create the browser window.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  var frameless = process.platform == "darwin";
  //var frameless = true;

  mainWindow = new BrowserWindow({
    width: Math.ceil(width * 0.9),
    height: Math.ceil(height * 0.9),
    frame: !frameless,
    show: false,
    webPreferences: {
      contextIsolation: false,
      enableRemoteModule: true,
      nodeIntegration: true,
      nativeWindowOpen: true,
    },
  });

  remote.enable(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' }
  })

  // and load the index.html of the app.
  mainWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, "./main/index.html"),
      protocol: "file:",
      slashes: true,
    })
  );

  mainWindow.setMenu(null);

  // Open the DevTools.
  if (process.env["deepnest_debug"] === "1")
    mainWindow.webContents.openDevTools();

  // Emitted when the window is closed.
  mainWindow.on("closed", function () {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    mainWindow = null;
  });

  if (process.env.SAVE_PLACEMENTS_PATH !== undefined) {
    global.NEST_DIRECTORY = process.env.SAVE_PLACEMENTS_PATH;
  } else {
    global.NEST_DIRECTORY = path.join(os.tmpdir(), "nest");
  }
  // make sure the export directory exists
  if (!fs.existsSync(global.NEST_DIRECTORY))
    fs.mkdirSync(global.NEST_DIRECTORY);
}

function createNotificationWindow(notification) {
  if (notificationWindow) {
    notificationWindow.close();
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  notificationWindow = new BrowserWindow({
    width: 750,
    height: 500,
    parent: mainWindow,
    // NOTE: deliberately NOT `alwaysOnTop`/`type: "notification"`. Those forced
    // the notification above every window on the OS (and, on some Linux WMs,
    // kept re-raising it over other applications). `modal` + `parent` already
    // keeps it above deepnest's own window without hijacking the whole desktop.
    center: true,
    maximizable: false,
    minimizable: false,
    resizable: false,
    modal: true,
    show: false,
    webPreferences: {
      contextIsolation: false,
      enableRemoteModule: true,
      nodeIntegration: true
    }
  });

  remote.enable(notificationWindow.webContents);
  notificationWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' }
  })

  notificationWindow.loadURL(
    url.format({
      pathname: path.join(__dirname, "./main/notification.html"),
      protocol: "file:",
      slashes: true
    })
  );

  notificationWindow.setMenu(null);
  // Open the DevTools.
  if (process.env["deepnest_debug"] === "1")
    notificationWindow.webContents.openDevTools();

  // Capture a local reference: a previously-closed notification window emits
  // its "closed" event asynchronously (after a new one may already exist), so
  // nulling the shared `notificationWindow` unconditionally could clobber the
  // current window and make `.show()` throw on null. Guard against that.
  const win = notificationWindow;
  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("closed", () => {
    if (notificationWindow === win) notificationWindow = null;
  });

  // Store the notification data for access by the renderer
  notificationWindow.notificationData = notification;
}

// Whether the user has opted in to product/update notifications. Defaults to
// ON; only a config with `showNotifications === false` disables it. When off we
// never fetch deepnest.net/app_notifications.json, so the app stays fully offline
// for notifications. `configPath` is a module-scope const defined below; this is
// only ever called at runtime (post-startup), so it is initialised by then.
function notificationsEnabled() {
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath).toString());
      return cfg.showNotifications !== false;
    }
  } catch (err) {
    console.error("Could not read notification setting, defaulting to on:", err);
  }
  return true;
}

async function runNotificationCheck() {
  if (!notificationsEnabled()) {
    return;
  }
  const notification = await notificationService.checkForNotifications();
  if (notification) {
    createNotificationWindow(notification);
  }
}


// One hidden window per GA individual. The old hard cap of 1 made the
// "threads" / CPU-cores setting a no-op. 4 matches the default config;
// background-set-threads resizes the pool (1..8) when a nest starts.
var workerPoolSize = 4;
var pendingWork = [];

function createBackgroundWindow() {
  var back = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: false,
      enableRemoteModule: true,
      nodeIntegration: true,
      nativeWindowOpen: true,
      // Hidden renderers are backgrounded. Leave timers and NFP workers
      // unthrottled or the extra windows will sit idle.
      backgroundThrottling: false,
    },
  });

  remote.enable(back.webContents);
  back.isBusy = false;
  back.isReady = false;

  if (process.env["deepnest_debug"] === "1") back.webContents.openDevTools();

  back.loadURL(
    url.format({
      pathname: path.join(__dirname, "./main/background.html"),
      protocol: "file:",
      slashes: true,
    })
  );

  back.webContents.on("render-process-gone", (event, details) => {
    console.error("Render process gone:", event, details);
  });
  back.on("render-process-gone", (event) => {
    console.error("Render process gone:", event);
  });
  back.on("closed", function () {
    var idx = backgroundWindows.indexOf(back);
    if (idx >= 0) {
      backgroundWindows[idx] = null;
    }
  });

  backgroundWindows.push(back);
  return back;
}

function liveBackgroundWindows() {
  var live = [];
  for (var i = 0; i < backgroundWindows.length; i++) {
    if (backgroundWindows[i]) {
      live.push(backgroundWindows[i]);
    }
  }
  return live;
}

function ensureBackgroundWindows(count) {
  var n = parseInt(count, 10);
  if (!n || n < 1) {
    n = 1;
  }
  if (n > 8) {
    n = 8;
  }
  workerPoolSize = n;

  var live = liveBackgroundWindows();
  while (live.length < workerPoolSize) {
    live.push(createBackgroundWindow());
  }

  // Shrink idle windows only. A busy one finishes its individual first.
  while (live.length > workerPoolSize) {
    var extra = live[live.length - 1];
    if (extra.isBusy) {
      break;
    }
    var idx = backgroundWindows.indexOf(extra);
    if (idx >= 0) {
      backgroundWindows[idx] = null;
    }
    extra.destroy();
    live.pop();
  }
}

function getFreeBackgroundWindow() {
  var live = liveBackgroundWindows();
  for (var i = 0; i < live.length; i++) {
    if (live[i].isReady && !live[i].isBusy) {
      return live[i];
    }
  }
  return null;
}

function dispatchWork(payload) {
  var win = getFreeBackgroundWindow();
  if (!win) {
    return false;
  }
  win.isBusy = true;
  win.webContents.send("background-start", payload);
  return true;
}

function flushPendingWork() {
  while (pendingWork.length > 0) {
    if (!dispatchWork(pendingWork[0])) {
      break;
    }
    pendingWork.shift();
  }
}

function destroyBackgroundWindows() {
  pendingWork = [];
  for (var i = 0; i < backgroundWindows.length; i++) {
    if (backgroundWindows[i]) {
      backgroundWindows[i].destroy();
      backgroundWindows[i] = null;
    }
  }
  backgroundWindows = [];
}

function createBackgroundWindows() {
  ensureBackgroundWindows(workerPoolSize);
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  createMainWindow();
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    createBackgroundWindows();
    
    // Check for notifications after a short delay to ensure the app is fully loaded
    setTimeout(async () => {
      runNotificationCheck();
    }, 3000); // 3 seconds

    setInterval(async () => {
      runNotificationCheck();
    }, 30*60*1000); // every 30 minutes
  });
  mainWindow.on("closed", () => {
    app.quit();
  });
});

// Quit when all windows are closed.
app.on("window-all-closed", function () {
  app.quit();
});

app.on("activate", function () {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    createMainWindow();
  }
});

app.on("before-quit", function () {
  var p = path.join(__dirname, "./nfpcache");
  if (fs.existsSync(p)) {
    fs.readdirSync(p).forEach(function (file, index) {
      var curPath = p + "/" + file;
      fs.unlinkSync(curPath);
    });
  }
});

//ipcMain.on('background-response', (event, payload) => mainWindow.webContents.send('background-response', payload));
//ipcMain.on('background-start', (event, payload) => backgroundWindows[0].webContents.send('background-start', payload));

ipcMain.on("background-ready", function (event) {
  for (var i = 0; i < backgroundWindows.length; i++) {
    try {
      if (backgroundWindows[i] && backgroundWindows[i].webContents == event.sender) {
        backgroundWindows[i].isReady = true;
        flushPendingWork();
        break;
      }
    } catch (ex) {
      // window may already be destroyed
    }
  }
});

ipcMain.on("background-set-threads", function (event, n) {
  ensureBackgroundWindows(n);
  flushPendingWork();
});

ipcMain.on("background-start", function (event, payload) {
  if (!dispatchWork(payload)) {
    pendingWork.push(payload);
    ensureBackgroundWindows(workerPoolSize);
  }
});

ipcMain.on("background-response", function (event, payload) {
  for (var i = 0; i < backgroundWindows.length; i++) {
    // todo: hack to fix errors on app closing - should instead close workers when window is closed
    try {
      if (backgroundWindows[i] && backgroundWindows[i].webContents == event.sender) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("background-response", payload);
        }
        backgroundWindows[i].isBusy = false;
        break;
      }
    } catch (ex) {
      // ignore errors, as they can reference destroyed objects during a window close event
    }
  }
  flushPendingWork();
  ensureBackgroundWindows(workerPoolSize);
});

ipcMain.on("background-progress", function (event, payload) {
  // todo: hack to fix errors on app closing - should instead close workers when window is closed
  try {
    mainWindow.webContents.send("background-progress", payload);
  } catch (ex) {
    // when shutting down while processes are running, this error can occur so ignore it for now.
  }
});

ipcMain.on("background-stop", function (event) {
  destroyBackgroundWindows();
  createBackgroundWindows();
});

// Backward compat with https://electron-settings.js.org/index.html#configure
const configPath = path.resolve(app.getPath("userData"), "settings.json");
ipcMain.handle("read-config", () => {
  return fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath).toString().replaceAll("http://convert.deepnest.io", "https://converter.deepnest.app/convert").replaceAll("https://convert.deepnest.io", "https://converter.deepnest.app/convert"))
    : {};
});
ipcMain.handle("write-config", (event, stringifiedConfig) => {
  fs.writeFileSync(configPath, stringifiedConfig);
});

ipcMain.on("login-success", function (event, payload) {
  mainWindow.webContents.send("login-success", payload);
});

ipcMain.on("purchase-success", function (event) {
  mainWindow.webContents.send("purchase-success");
});

ipcMain.on("setPlacements", (event, payload) => {
  global.exportedPlacements = payload;
});

ipcMain.on("test", (event, payload) => {
  global.test = payload;
});

ipcMain.handle("load-presets", () => {
  return loadPresets();
});

ipcMain.handle("save-preset", (event, name, config) => {
  savePreset(name, config);
});

ipcMain.handle("delete-preset", (event, name) => {
  deletePreset(name);
});

// Handle notification window events
ipcMain.on('get-notification-data', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win.notificationData) {
    event.reply('notification-data', {
      title: win.notificationData.title,
      content: win.notificationData.content
    });
  }
});

ipcMain.on('close-notification', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && win.notificationData && win.notificationData.markAsSeen) {
    win.notificationData.markAsSeen();
  }
  
  // Close the current notification window
  if (win) {
    win.close();
  }
  
  // Check for additional notifications and show them if they exist
  setTimeout(async () => {
    const nextNotification = await notificationService.checkForNotifications();
    if (nextNotification) {
      createNotificationWindow(nextNotification);
    }
  }, 500); // Small delay to ensure clean transition
});
