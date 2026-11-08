#!/usr/bin/env python3
"""Local Colab T4 model-phase supervisor: one GPU model family at a time.
The Next app must run in the same runtime; do not expose unauthenticated ports.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.request import urlopen

HOME = Path(os.environ.get('WEBTOON_DATA_DIR', './webtoon-data')).resolve() / '.runtime'
STATE = HOME / 'phase.json'

def read_state():
    try:
        return json.loads(STATE.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}

def alive(proc):
    pid = int(proc.get('pid', 0))
    if pid <= 1: return False
    try:
        os.kill(pid, 0)
        cmd = Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode(errors='ignore')
        return proc.get('tag', '') in cmd
    except (ProcessLookupError, FileNotFoundError, PermissionError):
        return False

def available_vram_mb():
    result = subprocess.run(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'],
                            check=True, capture_output=True, text=True)
    return min(int(line.strip()) for line in result.stdout.splitlines() if line.strip())

def stop():
    current = read_state()
    if not alive(current):
        STATE.unlink(missing_ok=True)
        return
    pid = int(current['pid'])
    try:
        os.killpg(pid, signal.SIGTERM)
        for _ in range(60):
            if not alive(current): break
            time.sleep(0.25)
        if alive(current): os.killpg(pid, signal.SIGKILL)
    finally:
        STATE.unlink(missing_ok=True)

def http_ready(url):
    try:
        with urlopen(url, timeout=2) as response:
            return response.status < 500
    except Exception:
        return False

def launch(command, mode, tag, health_url, min_free_mb):
    HOME.mkdir(parents=True, exist_ok=True)
    if alive(read_state()):
        print('Stopping previous model family before loading', mode, flush=True)
        stop()
    free=available_vram_mb()
    if free < min_free_mb:
        raise RuntimeError(f'Insufficient free VRAM for {mode}: {free}MB')
    log=HOME/f'{mode}.log'
    with log.open('ab') as output:
        process=subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True, env=os.environ.copy())
    record={'mode':mode,'pid':process.pid,'tag':tag,'command':command,
            'log':str(log),'started_at':time.time()}
    STATE.write_text(json.dumps(record,indent=2),encoding='utf-8')
    for _ in range(90):
        if process.poll() is not None:
            raise RuntimeError(f'{mode} exited with {process.returncode}; inspect {log}')
        if http_ready(health_url):
            print(json.dumps({'status':'ready','mode':mode,'log':str(log)}))
            return
        time.sleep(2)
    raise RuntimeError(f'{mode} health check timed out; inspect {log}')

def main():
    parser=argparse.ArgumentParser(description='Colab T4 sequential inference supervisor')
    sub=parser.add_subparsers(dest='action',required=True)
    llm=sub.add_parser('start-llm')
    llm.add_argument('--binary',required=True,help='compiled llama-server executable')
    llm.add_argument('--model',required=True,help='Qwen3.5-9B Q4_K_M GGUF')
    llm.add_argument('--lora',default='',help='optional story LoRA GGUF')
    llm.add_argument('--ctx',type=int,default=8192)
    comfy=sub.add_parser('start-image')
    comfy.add_argument('--comfy-dir',required=True)
    comfy.add_argument('--python',default=sys.executable)
    sub.add_parser('stop')
    sub.add_parser('status')
    args=parser.parse_args()
    if args.action=='stop':
        stop();print('stopped');return
    if args.action=='status':
        current=read_state()
        print(json.dumps({'running':alive(current),'record':current,
                          'vram_free_mb':available_vram_mb()},indent=2))
        return
    if args.action=='start-llm':
        if not Path(args.binary).is_file() or not Path(args.model).is_file():
            raise FileNotFoundError('Missing llama-server executable or Q4 model')
        if args.lora and not Path(args.lora).is_file():
            raise FileNotFoundError('Story LoRA was not found')
        command=[str(Path(args.binary).resolve()),'--model',str(Path(args.model).resolve()),
                 '--alias','Qwen3.5-9B','--host','127.0.0.1','--port','8000',
                 '--ctx-size',str(args.ctx),'--n-gpu-layers','99']
        if args.lora: command.extend(['--lora',str(Path(args.lora).resolve())])
        launch(command,'llm','llama-server','http://127.0.0.1:8000/health',6500)
    else:
        directory=Path(args.comfy_dir).resolve()
        if not (directory/'main.py').is_file():
            raise FileNotFoundError('ComfyUI main.py not found')
        launch([args.python,str(directory/'main.py'),'--listen','127.0.0.1',
                '--port','8188','--disable-auto-launch'],
               'image','main.py','http://127.0.0.1:8188/system_stats',8000)

if __name__=='__main__':
    main()
