#!/bin/bash
# PaperNexus Service Management Script
# Quick commands to manage PaperNexus system services

set -euo pipefail

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    else
        echo "unknown"
    fi
}

OS=$(detect_os)

# Usage
usage() {
    echo "PaperNexus Service Manager"
    echo ""
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  start     - Start the PaperNexus web server service"
    echo "  stop      - Stop the PaperNexus web server service"
    echo "  restart   - Restart the PaperNexus web server service"
    echo "  status    - Show service status"
    echo "  logs      - View service logs (follow mode)"
    echo "  enable    - Enable service to start on boot"
    echo "  disable   - Disable service from starting on boot"
    echo "  install   - Install the service (runs install-service.sh)"
    echo "  uninstall - Uninstall the service"
    echo ""
    echo "Examples:"
    echo "  $0 start"
    echo "  $0 logs"
    echo "  $0 status"
}

# macOS commands
macos_start() {
    launchctl load -w "$HOME/Library/LaunchAgents/io.github.papernexus.serve.plist"
    echo "PaperNexus service started (macOS)"
}

macos_stop() {
    launchctl unload -w "$HOME/Library/LaunchAgents/io.github.papernexus.serve.plist"
    echo "PaperNexus service stopped (macOS)"
}

macos_restart() {
    macos_stop
    sleep 2
    macos_start
}

macos_status() {
    echo "PaperNexus Services (macOS):"
    launchctl list | grep papernexus || echo "No services found"
}

macos_logs() {
    tail -f ~/Library/Logs/PaperNexus/*.out 2>/dev/null || echo "No logs found"
}

macos_enable() {
    launchctl load -w "$HOME/Library/LaunchAgents/io.github.papernexus.serve.plist"
    echo "PaperNexus service enabled (macOS)"
}

macos_disable() {
    launchctl unload -w "$HOME/Library/LaunchAgents/io.github.papernexus.serve.plist"
    echo "PaperNexus service disabled (macOS)"
}

# Linux commands
linux_start() {
    systemctl --user start papernexus-serve.service
    echo "PaperNexus service started (Linux)"
}

linux_stop() {
    systemctl --user stop papernexus-serve.service
    echo "PaperNexus service stopped (Linux)"
}

linux_restart() {
    systemctl --user restart papernexus-serve.service
    echo "PaperNexus service restarted (Linux)"
}

linux_status() {
    systemctl --user status papernexus-serve.service
}

linux_logs() {
    journalctl --user -u papernexus-serve -f
}

linux_enable() {
    systemctl --user enable papernexus-serve.service
    echo "PaperNexus service enabled (Linux)"
}

linux_disable() {
    systemctl --user disable papernexus-serve.service
    echo "PaperNexus service disabled (Linux)"
}

# Main
case "${1:-}" in
    start)
        if [[ "$OS" == "macos" ]]; then
            macos_start
        elif [[ "$OS" == "linux" ]]; then
            linux_start
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    stop)
        if [[ "$OS" == "macos" ]]; then
            macos_stop
        elif [[ "$OS" == "linux" ]]; then
            linux_stop
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    restart)
        if [[ "$OS" == "macos" ]]; then
            macos_restart
        elif [[ "$OS" == "linux" ]]; then
            linux_restart
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    status)
        if [[ "$OS" == "macos" ]]; then
            macos_status
        elif [[ "$OS" == "linux" ]]; then
            linux_status
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    logs)
        if [[ "$OS" == "macos" ]]; then
            macos_logs
        elif [[ "$OS" == "linux" ]]; then
            linux_logs
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    enable)
        if [[ "$OS" == "macos" ]]; then
            macos_enable
        elif [[ "$OS" == "linux" ]]; then
            linux_enable
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    disable)
        if [[ "$OS" == "macos" ]]; then
            macos_disable
        elif [[ "$OS" == "linux" ]]; then
            linux_disable
        else
            echo "Unsupported OS: $OS"
            exit 1
        fi
        ;;
    install)
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        "$SCRIPT_DIR/install-service.sh" install
        ;;
    uninstall)
        SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        "$SCRIPT_DIR/install-service.sh" uninstall
        ;;
    *)
        usage
        exit 1
        ;;
esac
