#!/usr/bin/env python3
"""
PTY runner for claude: creates a pseudo-TTY and runs claude -p inside it.
This lets claude work in non-interactive mode by pretending to be a terminal.
"""
import argparse
import os
import pty
import select
import sys
import time
import fcntl
import struct
import termios

def run_claude(model: str, prompt: str, timeout: int = 30):
    """Run claude -p inside a PTY and capture output."""
    
    def set_pty_size(fd, rows, cols):
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    
    master_fd, slave_fd = pty.openpty()
    set_pty_size(master_fd, 40, 120)
    
    pid = os.fork()
    if pid == 0:
        # Child
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(slave_fd)
        os.execvp('claude', ['claude', '--model', model, '-p', prompt])
        sys.exit(1)
    
    # Parent
    os.close(slave_fd)
    
    # Set master to non-blocking
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    
    output = []
    deadline = time.time() + timeout
    
    while time.time() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.5)
        if ready:
            try:
                chunk = os.read(master_fd, 4096)
                if chunk:
                    output.append(chunk)
                    # Heuristic: if we see a prompt back, we're done
                    if b'\n~ ' in chunk or b'\n> ' in chunk:
                        break
            except OSError:
                break
        
        # Check if child exited
        result = os.waitpid(pid, os.WNOHANG)
        if result[0] != 0:
            break
    
    os.close(master_fd)
    
    # Drain any remaining output
    time.sleep(0.3)
    try:
        while True:
            ready, _, _ = select.select([master_fd], [], [], 0.2)
            if not ready:
                break
            try:
                chunk = os.read(master_fd, 4096)
                if chunk:
                    output.append(chunk)
            except OSError:
                break
    except:
        pass
    
    return b''.join(output).decode('utf-8', errors='replace').strip()

def main():
    parser = argparse.ArgumentParser(description='PTY wrapper for claude -p')
    parser.add_argument('--model', default='codex')
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--timeout', type=int, default=30)
    args = parser.parse_args()
    
    result = run_claude(args.model, args.prompt, args.timeout)
    print(result, end='')

if __name__ == '__main__':
    main()
