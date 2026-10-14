# Capital Trust Bank

A demonstration banking website. Customers register, request deposits, withdrawals and transfers, order a card through live support, and chat with the bank. An administrator approves transactions, issues cards and answers support chats. No real money is involved.

Built with plain HTML, CSS and JavaScript and a small Node.js server that uses Node's built-in SQLite. There are no npm dependencies.

## Run it locally

Requires Node.js 22.13 or newer.

```
npm start
```

Then open http://localhost:3000. The admin console is at http://localhost:3000/admin.

On first start the server creates the admin account and prints its login. Set these environment variables to change it:

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_EMAIL` | `admin@capitaltrust.local` | Admin login email |
| `ADMIN_PASSWORD` | `Admin@12345` | Admin password, used only when the admin account is first created |
| `PORT` | `3000` | Port the server listens on |
| `DATA_DIR` | `./data` | Where the SQLite database is stored |

## Deploy on Render

Create a **Web Service** from this repository:

- Build command: leave empty
- Start command: `npm start`
- Environment: set `ADMIN_PASSWORD` to a private value

The Node version comes from `.node-version`. On Render's free tier the database is wiped whenever the service restarts; attach a persistent disk and point `DATA_DIR` at it to keep data.
