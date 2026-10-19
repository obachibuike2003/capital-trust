# Capital Trust Bank

Capital Trust Bank is an online banking website. Customers register and log in, deposit and withdraw money (a withdrawal sends money to any account and needs a card), order a card through live support, and chat with the bank. An administrator reviews and approves transactions, issues cards, and answers support chats.

Built with plain HTML, CSS and JavaScript, a Node.js banking API using Node's built-in SQLite, and an optional Flask-Mail notification service.

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

### Render static frontend with EC2 backend

This split deployment requires a custom domain with two HTTPS subdomains under the same registrable domain, for example `app.example.com` on Render and `api.example.com` on EC2. This keeps the session cookie same-site. The default `*.onrender.com` hostname and an unrelated EC2 hostname are cross-site and may have their cookies blocked by browsers.

1. Create a Render Static Site from this repository with publish directory `public/` and no build command.
2. Add Render rewrite rules for `/login` to `/login.html`, `/register` to `/register.html`, `/dashboard` to `/dashboard.html`, and `/admin` to `/admin.html`.
3. After assigning your custom domains and TLS, set `apiBaseUrl` in `public/js/config.js` to `https://api.example.com` before deploying the static files.
4. On EC2, run the Node API behind an HTTPS reverse proxy and set `NODE_ENV=production`, `COOKIE_SECURE=true`, and `FRONTEND_ORIGINS=https://app.example.com`. Keep the Node port private behind that proxy and persist `DATA_DIR` on attached storage.
5. Run Flask on the EC2 instance or privately alongside Node. Set Node's `NOTIFICATION_SERVICE_URL` to the private Flask address and use the same `NOTIFICATION_SERVICE_TOKEN` in both processes.

Replace `example.com` with a domain you control. The API hostname and frontend custom domain are not configured in this repository yet, so the static site is not ready for authenticated production traffic until those DNS/TLS settings are in place.

### Email notifications

The notification sidecar lives in `notifications/` and sends branded HTML plus plain-text account emails. The Node service keeps serving the banking API if the notification service is not configured or email delivery fails.

For local development, set `notifications/.env` (this file is git-ignored) and run the service from the `notifications/` directory:

```powershell
python -m pip install -r requirements.txt
python app.py
```

Run the notification tests from the same directory with `python -m unittest discover -s tests -v`.

`MAIL_SUPPRESS_SEND=true` is for development/tests only and does not deliver email. In a second terminal, start the Node app with the same token and `NOTIFICATION_SERVICE_URL=http://127.0.0.1:5000` to exercise notification events. To deliver mail, configure SMTP with `MAIL_SERVER`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_DEFAULT_SENDER`, and either `MAIL_USE_TLS=true` or `MAIL_USE_SSL=true`.

Gmail defaults to `smtp.gmail.com:587` with TLS. On EC2, set `MAIL_USERNAME` to the Gmail address and `MAIL_PASSWORD` to a newly rotated Google App Password. If `MAIL_DEFAULT_SENDER` is omitted, it uses `MAIL_USERNAME`. Configure these in the instance/service environment or a secrets manager; never commit them.

On Render, create a second Web Service from this repository with root directory `notifications/`, build command `pip install -r requirements.txt`, and start command `gunicorn app:app --bind 0.0.0.0:$PORT`. Set its SMTP variables and a random `NOTIFICATION_SERVICE_TOKEN`. On the Node service, set the same token and `NOTIFICATION_SERVICE_URL` to the Flask service's internal URL. Keep the token and SMTP credentials in Render environment settings, not in source control.

The selected events are account creation, withdrawal submission, transaction approval/rejection, and support replies. SMS consent is stored, but SMS is intentionally disabled until a destination country and delivery provider are selected. A Python package cannot make production SMS free; providers may offer limited trials or sandboxes, while real delivery is generally paid.
