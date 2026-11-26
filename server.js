// SENGAJA RENTAN - hanya untuk tes GHAS Code Scanning (CodeQL). Jangan dipakai di production.
const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql");

const app = express();
const db = mysql.createConnection({ host: "localhost", user: "app", database: "app" });

// js/sql-injection
app.get("/user", (req, res) => {
  db.query("SELECT * FROM users WHERE name = '" + req.query.nama + "'", (err, rows) => {
    if (err) return res.status(500).send("error");
    res.json(rows);
  });
});

// js/command-line-injection
app.get("/ping", (req, res) => {
  exec("ping -c 1 " + req.query.host, (err, out) => res.send(out));
});

// js/reflected-xss
app.get("/hello", (req, res) => {
  res.send("<h1>Halo " + req.query.name + "</h1>");
});

// js/path-injection
app.get("/file", (req, res) => {
  res.send(fs.readFileSync(path.join("/var/data", req.query.path), "utf8"));
});

// js/server-side-unvalidated-url-redirection
app.get("/go", (req, res) => {
  res.redirect(req.query.next);
});

// js/code-injection
app.get("/calc", (req, res) => {
  res.send(String(eval(req.query.expr)));
});

app.listen(3000);
