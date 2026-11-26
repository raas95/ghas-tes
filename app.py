import sqlite3

def cari_user(nama):
    conn = sqlite3.connect("db.sqlite")
    query = "SELECT * FROM users WHERE name = '" + nama + "'"
    return conn.execute(query).fetchall()