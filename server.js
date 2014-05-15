#!/usr/bin/env node
var pkg = require('./package.json');
var execFile = require('child_process').execFile;
var fs = require('fs');
var path = require('path');
var program = require('commander');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var util = require('util');

//parse args
program
  .version(pkg.version)
  .usage('[options]')
  .option('-d, --dir [dir]', 'Repositories directory. Defaults to script installation dir', path.join(__dirname, 'repos'))
  .option('-f, --file', 'Write to deploy.txt instead of stdouterr')
  .option('-h, --host [ip]', 'Host [ip] to bind on', "0.0.0.0")
  .option('-p, --port [number]', 'Port [number] to listen on', 3240)
  .option('--clean-install', 'Delete old "node_modules" before "npm install"ing')
  .option('--wipe-app [app]', 'Wipe one application')
  .option('--wipe-all', 'Wipe everything')
  .parse(process.argv);

//logging
require('logbook').configure({
  console: {
    log: !program.file,
    err: !program.file,
    timestamps: true,
    typestamps: true
  },
  file: {
    log: program.file,
    err: program.file,
    logPath: './deploy.txt',
    errPath: './deploy.txt',
    timestamps: true,
    typestamps: false
  }
});

var DB_DIR = path.join(__dirname, 'database');
var db = require('level')(DB_DIR, { valueEncoding: 'json' });

var REPOS_DIR = program.dir;
mkdirp.sync(REPOS_DIR);

if(program.wipeApp) {
  var app = program.wipeApp;
  db.del(app);
  rimraf.sync(path.join(REPOS_DIR, app));
  info("Wiped '%s'", app);
  process.exit(1);
} else if(program.wipeAll) {
  rimraf.sync(DB_DIR);
  rimraf.sync(REPOS_DIR);
  info("Wiped all deployment data");
  process.exit(1);
}

//start forever server
var procs = {};

//start webhook server
require("http").createServer(function(req, res) {
  var json = "";
  req.on("data", function(buff) {
    json += buff;
  });
  req.on("end", function() {
    try {
      var hook = JSON.parse(json);
      if(!hook.repository)
        throw "missing 'repository'";
      var name = hook.repository.name;
      var url = require('url');
      var u = url.parse(req.url, true);

      var app = {
        name: name,
        branch: u.query.branch || 'master',
        dir: path.join(REPOS_DIR, u.query.repoName || name),
        startCommand: u.query.startCommand || 'npm start',
        git: hook.repository.url
      };
      db.put(name, app);
      app.proc = procs[name];
      onHook(app);
      res.writeHead(200);
    } catch(e) {
      error("invalid: " + e);
      res.writeHead(400);
    }
    res.end();
  });
}).listen(program.port, program.host, function() {
  info("Gitlab deployment server bound to %s:%s...", program.host, program.port);
});

//reload existing apps
db.createReadStream().on('data', function (data) {
  var app = data.value;
  onHook(app);
});

function onHook(app) {
  stop(app, function(err) {
    if(err) return error(err);
    reinstall(app, function(err) {
      if(err) return error(err);
      start(app, function(err) {
        if(err) return error(err);
      });
    });
  });
}

function reinstall(app, next) {

  function install() {

    if(program.cleanInstall)
      rimraf.sync(path.join(app.dir, 'node_modules'));

    exec("npm", ["install"], { cwd: app.dir }).on("exit", function(code) {
      if(code !== 0) return next("npm install error");
      next();
    });
  }

  if(fs.existsSync(app.dir)) {
    exec("git", ["reset", "--hard"], { cwd: app.dir }).on("exit", function(code) {
      if(code !== 0) return next("git reset error");
      exec("git", ["pull"], { cwd: app.dir }).on("exit", function(code) {
        if(code !== 0) return next("git fetch error");
        install();
      });
    });
  } else {
    exec("git", ["clone",  "-b", app.branch, "--single-branch", app.git, app.dir]).on("exit", function(code) {
      if(code !== 0) return next("git clone error");
      install();
    });
  }
}

function start(app, next) {
  var cmdln = app.startCommand.split(" ");
  var proc = app.proc = procs[app.name] = exec(cmdln[0], cmdln.slice(1), { cwd: app.dir });

  proc.on("error", function(err) {
    error("app error: %s: %s", app.name, err);
  });

  proc.once("exit", function(code) {
    console.log("> %s exited with %s", app.name, code || 0);
    app.proc = procs[app.name] = null;
  });

  proc.stdout.on('data', function(buff) {
    log("> %s: %s", app.name, buff.toString().replace(/\n$/, ''));
  });
  proc.stderr.on('data', function(buff) {
    error("> %s: %s", app.name, buff.toString().replace(/\n$/, ''));
  });

  next(null);
}

function stop(app, next) {
  if(!app.proc)
    return next(null);
  log(">> sent '%s' SIGHUP", app.name);
  app.proc.kill('SIGHUP');
  app.proc.once("exit", function() {
    next(null);
  });
}

function exec(file, args, opts) {
  var extra = "";
  if(opts)
    if(opts.cwd)
      extra = util.format(" (from '%s')", opts.cwd);
  var str = file + " " + args.join(" ");
  log(">> '%s' executing%s", str, extra);
  var proc = execFile.apply(null, arguments);
  proc.once("exit", function(code) {
    log(">> '%s' exited with %s", str, code || 0);
  });
  return proc;
}

function log() {
  console.log.apply(console, arguments);
}

function info() {
  console.info.apply(console, arguments);
}

function error() {
  //TODO email or someting...
  console.error.apply(console, arguments);
}
