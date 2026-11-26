# SENGAJA RENTAN - hanya untuk tes GHAS Code Scanning (CodeQL). Jangan dipakai di production.
import os
import pickle
import sqlite3
import subprocess

from flask import Flask, request, make_response, redirect

app = Flask(__name__)


# py/sql-injection
@app.route("/user")
def cari_user():
    nama = request.args.get("nama", "")
    conn = sqlite3.connect("db.sqlite")
    query = "SELECT * FROM users WHERE name = '" + nama + "'"
    return str(conn.execute(query).fetchall())


# py/command-line-injection
@app.route("/ping")
def ping():
    host = request.args.get("host", "")
    return subprocess.check_output("ping -c 1 " + host, shell=True)


# py/reflective-xss
@app.route("/hello")
def hello():
    name = request.args.get("name", "")
    return make_response("<h1>Halo " + name + "</h1>")


# py/path-injection
@app.route("/file")
def baca_file():
    path = request.args.get("path", "")
    with open(os.path.join("/var/data", path)) as f:
        return f.read()


# py/unsafe-deserialization
@app.route("/load", methods=["POST"])
def load():
    return str(pickle.loads(request.get_data()))


# py/url-redirection
@app.route("/go")
def go():
    return redirect(request.args.get("next", "/"))


# py/code-injection
@app.route("/calc")
def calc():
    return str(eval(request.args.get("expr", "0")))


if __name__ == "__main__":
    # py/flask-debug
    app.run(debug=True)
