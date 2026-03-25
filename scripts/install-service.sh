#!/bin/bash
# PaperNexus Service Installation Script
# Installs PaperNexus as a system service (systemd on Linux, launchd on macOS)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAPERNEXUS_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="papernexus"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    else
        log_error "Unsupported OS: $OSTYPE"
        exit 1
    fi
}

# Install on macOS using launchd
install_macos() {
    local PLIST_DIR="$HOME/Library/LaunchAgents"
    local LOG_DIR="$HOME/Library/Logs/PaperNexus"
    
    mkdir -p "$PLIST_DIR"
    mkdir -p "$LOG_DIR"
    
    log_info "Installing PaperNexus services on macOS..."
    
    # Copy and configure serve plist
    local serve_plist="$PLIST_DIR/io.github.papernexus.serve.plist"
    cp "$SCRIPT_DIR/macos/io.github.papernexus.serve.plist" "$serve_plist"
    sed -i '' "s|%INSTALL_DIR%|$PAPERNEXUS_DIR|g" "$serve_plist"
    sed -i '' "s|%LOG_DIR%|$LOG_DIR|g" "$serve_plist"
    
    # Copy and configure watch plist (optional)
    local watch_plist="$PLIST_DIR/io.github.papernexus.watch.plist"
    cp "$SCRIPT_DIR/macos/io.github.papernexus.watch.plist" "$watch_plist"
    sed -i '' "s|%INSTALL_DIR%|$PAPERNEXUS_DIR|g" "$watch_plist"
    sed -i '' "s|%LOG_DIR%|$LOG_DIR|g" "$watch_plist"
    
    # Ask for paper directory if not provided
    if [[ -z "${PAPER_DIR:-}" ]]; then
        read -p "Enter papers directory path (relative to $PAPERNEXUS_DIR): " PAPER_DIR
        PAPER_DIR="$PAPERNEXUS_DIR/$PAPER_DIR"
    fi
    
    if [[ -z "${CORPUS_NAME:-}" ]]; then
        read -p "Enter corpus name (default: my-papers): " CORPUS_NAME
        CORPUS_NAME="${CORPUS_NAME:-my-papers}"
    fi
    
    sed -i '' "s|%PAPER_DIR%|$PAPER_DIR|g" "$watch_plist"
    sed -i '' "s|%CORPUS_NAME%|$CORPUS_NAME|g" "$watch_plist"
    
    # Load services
    log_info "Loading launchd agents..."
    launchctl unload "$serve_plist" 2>/dev/null || true
    launchctl load -w "$serve_plist"
    
    log_info "PaperNexus serve service installed!"
    log_info "  Service: io.github.papernexus.serve"
    log_info "  Web UI: http://127.0.0.1:4821"
    
    # Optionally load watch service
    read -p "Enable watch mode for continuous corpus monitoring? (y/n): " enable_watch
    if [[ "$enable_watch" == "y" || "$enable_watch" == "Y" ]]; then
        launchctl unload "$watch_plist" 2>/dev/null || true
        launchctl load -w "$watch_plist"
        log_info "PaperNexus watch service installed!"
        log_info "  Watching: $PAPER_DIR"
        log_info "  Corpus: $CORPUS_NAME"
    fi
    
    log_info ""
    log_info "Useful commands:"
    log_info "  View logs:    tail -f $LOG_DIR/papernexus-serve.out"
    log_info "  Stop serve:   launchctl unload -w $serve_plist"
    log_info "  Start serve:  launchctl load -w $serve_plist"
    log_info "  Status:       launchctl list | grep papernexus"
}

# Install on Linux using systemd
install_linux() {
    local SYSTEMD_DIR="$HOME/.config/systemd/user"
    local JOURNAL_CMD="journalctl --user -u papernexus-serve -f"
    
    mkdir -p "$SYSTEMD_DIR"
    
    log_info "Installing PaperNexus services on Linux..."
    
    # Ask for paper directory if not provided
    if [[ -z "${PAPER_DIR:-}" ]]; then
        read -p "Enter papers directory path (relative to $PAPERNEXUS_DIR): " PAPER_DIR
        PAPER_DIR="$PAPERNEXUS_DIR/$PAPER_DIR"
    fi
    
    if [[ -z "${CORPUS_NAME:-}" ]]; then
        read -p "Enter corpus name (default: my-papers): " CORPUS_NAME
        CORPUS_NAME="${CORPUS_NAME:-my-papers}"
    fi
    
    # Copy and configure serve service
    local serve_service="$SYSTEMD_DIR/papernexus-serve.service"
    cp "$SCRIPT_DIR/systemd/papernexus-serve.service" "$serve_service"
    sed -i "s|%USER%|$(whoami)|g" "$serve_service"
    sed -i "s|%GROUP%|$(id -gn)|g" "$serve_service"
    sed -i "s|%INSTALL_DIR%|$PAPERNEXUS_DIR|g" "$serve_service"
    
    # Copy and configure watch service
    local watch_service="$SYSTEMD_DIR/papernexus-watch.service"
    cp "$SCRIPT_DIR/systemd/papernexus-watch.service" "$watch_service"
    sed -i "s|%USER%|$(whoami)|g" "$watch_service"
    sed -i "s|%GROUP%|$(id -gn)|g" "$watch_service"
    sed -i "s|%INSTALL_DIR%|$PAPERNEXUS_DIR|g" "$watch_service"
    sed -i "s|%PAPER_DIR%|$PAPER_DIR|g" "$watch_service"
    sed -i "s|%CORPUS_NAME%|$CORPUS_NAME|g" "$watch_service"
    
    # Copy timer
    local timer_file="$SYSTEMD_DIR/papernexus-serve.timer"
    cp "$SCRIPT_DIR/systemd/papernexus-serve.timer" "$timer_file"
    
    # Reload systemd and enable services
    log_info "Reloading systemd daemon..."
    systemctl --user daemon-reload
    
    systemctl --user enable papernexus-serve.service
    systemctl --user start papernexus-serve.service
    
    log_info "PaperNexus serve service installed!"
    log_info "  Service: papernexus-serve"
    log_info "  Web UI: http://127.0.0.1:4821"
    
    # Optionally enable watch service
    read -p "Enable watch mode for continuous corpus monitoring? (y/n): " enable_watch
    if [[ "$enable_watch" == "y" || "$enable_watch" == "Y" ]]; then
        systemctl --user enable papernexus-watch.service
        systemctl --user start papernexus-watch.service
        log_info "PaperNexus watch service installed!"
        log_info "  Watching: $PAPER_DIR"
        log_info "  Corpus: $CORPUS_NAME"
    fi
    
    log_info ""
    log_info "Useful commands:"
    log_info "  View logs:    $JOURNAL_CMD"
    log_info "  Stop serve:   systemctl --user stop papernexus-serve"
    log_info "  Start serve:  systemctl --user start papernexus-serve"
    log_info "  Status:       systemctl --user status papernexus-serve"
}

# Uninstall service
uninstall_service() {
    local os=$(detect_os)
    
    log_info "Uninstalling PaperNexus services..."
    
    if [[ "$os" == "macos" ]]; then
        local PLIST_DIR="$HOME/Library/LaunchAgents"
        
        launchctl unload -w "$PLIST_DIR/io.github.papernexus.serve.plist" 2>/dev/null || true
        launchctl unload -w "$PLIST_DIR/io.github.papernexus.watch.plist" 2>/dev/null || true
        
        rm -f "$PLIST_DIR/io.github.papernexus.serve.plist"
        rm -f "$PLIST_DIR/io.github.papernexus.watch.plist"
        
        log_info "Services uninstalled. Logs still available at ~/Library/Logs/PaperNexus/"
        
    elif [[ "$os" == "linux" ]]; then
        local SYSTEMD_DIR="$HOME/.config/systemd/user"
        
        systemctl --user stop papernexus-serve.service 2>/dev/null || true
        systemctl --user stop papernexus-watch.service 2>/dev/null || true
        systemctl --user disable papernexus-serve.service 2>/dev/null || true
        systemctl --user disable papernexus-watch.service 2>/dev/null || true
        
        rm -f "$SYSTEMD_DIR/papernexus-serve.service"
        rm -f "$SYSTEMD_DIR/papernexus-watch.service"
        rm -f "$SYSTEMD_DIR/papernexus-serve.timer"
        
        systemctl --user daemon-reload
        
        log_info "Services uninstalled."
    fi
}

# Show service status
show_status() {
    local os=$(detect_os)
    
    if [[ "$os" == "macos" ]]; then
        echo "PaperNexus Services Status (macOS):"
        echo "===================================="
        launchctl list | grep papernexus || echo "No PaperNexus services running"
        echo ""
        echo "Logs:"
        tail -20 ~/Library/Logs/PaperNexus/*.out 2>/dev/null || echo "No logs found"
        
    elif [[ "$os" == "linux" ]]; then
        echo "PaperNexus Services Status (Linux):"
        echo "===================================="
        systemctl --user status papernexus-serve.service 2>/dev/null || echo "Serve service not found"
        echo ""
        systemctl --user status papernexus-watch.service 2>/dev/null || echo "Watch service not found"
    fi
}

# Main
main() {
    local action="${1:-install}"
    
    case "$action" in
        install)
            install_service
            ;;
        uninstall)
            uninstall_service
            ;;
        status)
            show_status
            ;;
        *)
            echo "Usage: $0 {install|uninstall|status}"
            exit 1
            ;;
    esac
}

install_service() {
    local os=$(detect_os)
    
    if [[ "$os" == "macos" ]]; then
        install_macos
    elif [[ "$os" == "linux" ]]; then
        install_linux
    fi
}

main "$@"
