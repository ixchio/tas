# TAS Systemd Service Setup

## Install the sync service to start automatically on boot:

```bash
# 1. Copy service file
sudo cp systemd/tas-sync.service /etc/systemd/user/

# 2. Edit the service file - replace USER with your username
sudo nano /etc/systemd/user/tas-sync.service

# 3. Create password file (for headless operation)
echo "your-password" > ~/.tas-password
chmod 600 ~/.tas-password

# 4. Enable and start the service
systemctl --user daemon-reload
systemctl --user enable tas-sync
systemctl --user start tas-sync

# 5. Check status
systemctl --user status tas-sync

# 6. View logs
journalctl --user -u tas-sync -f
```

## To stop the service:
```bash
systemctl --user stop tas-sync
systemctl --user disable tas-sync
```
