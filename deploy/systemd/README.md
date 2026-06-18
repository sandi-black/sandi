# Systemd unit templates

These units are the recommended direct-host service definitions for Sandi's
Discord and GitHub surfaces.

They assume the standard direct-host layout:

- app checkout: `/srv/sandi/app`
- runtime environment file: `/srv/sandi/app/.env`
- Volta-managed Node on root's `PATH`
- checked-out `tsx` binary at `/srv/sandi/app/node_modules/.bin/tsx`

Install or refresh them with:

```sh
sudo cp deploy/systemd/sandi.service /etc/systemd/system/sandi.service
sudo cp deploy/systemd/sandi-github.service /etc/systemd/system/sandi-github.service
sudo systemctl daemon-reload
sudo systemctl enable --now sandi.service sandi-github.service
```

After changing unit files, restart services when ready:

```sh
sudo systemctl restart sandi.service sandi-github.service
```

The units invoke `tsx` directly rather than using `npm run start` wrappers. This
keeps routine systemd stop signals aimed at the long-running Node process and
avoids npm reporting clean Sandi shutdowns as failed signal exits.
