import asyncio
import getpass
import os

import asyncpg
from dotenv import load_dotenv
from pwdlib import PasswordHash

load_dotenv()


async def main():
    database_url = os.environ["DATABASE_URL"]
    email = input("Administrator email: ").strip()
    name = input("Administrator name: ").strip()
    password = getpass.getpass("Password (minimum 12 characters): ")
    if len(password) < 12:
        raise SystemExit("Password must be at least 12 characters.")
    pool = await asyncpg.create_pool(database_url)
    try:
        await pool.execute(
            "INSERT INTO users(email,full_name,role,password_hash) VALUES($1,$2,'ADMIN',$3)",
            email, name, PasswordHash.recommended().hash(password),
        )
    finally:
        await pool.close()
    print(f"Administrator account created for {email}.")


if __name__ == "__main__":
    asyncio.run(main())
