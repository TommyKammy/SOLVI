from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from urllib.request import urlopen
import os
import shutil
import socket
import subprocess
import sys
from threading import Lock
import time

ROOT = Path.cwd()
TMP = Path(__file__).parent
MIGRATION_LOCK = Lock()
STAGES = {
    '01': ('WP-P2-UIX-048', 'uix048', 3182, 3183),
    '02': ('WP-P2-UIX-049', 'uix049', 3190, 3191),
    '03': ('WP-P4-APR-022', 'apr022', 3200, 3201),
    '04': ('WP-P3-KNWUI-060', 'knwui060', 3210, 3211),
    '05': ('WP-P7-CHGUI-005', 'chgui005', 3220, 3221),
    '06': ('WP-P2-ADMUI-050', 'admui050', 3230, 3231),
    '07': ('WP-P2-RPT-051', 'rpt051', 3240, 3241),
    '08': ('WP-P4-SIMUI-023', 'simui023', 3250, 3251),
    'visual': ('WP-P2-UIX-052', 'uix052', 3260, 3261),
}

def assert_free(port):
    with socket.socket() as s:
        s.bind(('127.0.0.1', port))

def ready(url, process):
    for _ in range(80):
        if process.poll() is not None:
            raise RuntimeError(f'server exited before {url}')
        try:
            with urlopen(url, timeout=2) as reply:
                if reply.status == 200:
                    return
        except OSError:
            time.sleep(0.3)
    raise RuntimeError(f'server did not become ready {url}')

def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()

def run(stage, build, label, build_token):
    wp, prefix, web, api = STAGES[stage]
    out = TMP / label / stage
    out.mkdir(parents=True)
    src, = (ROOT / 'evidence' / wp).glob('*/capture.mjs.txt')
    patch_dir = TMP / 'overrides' / stage
    for script in src.parent.glob('*.mjs.txt'):
        override = patch_dir / script.name
        shutil.copyfile(override if override.exists() else script, out / script.name.removesuffix('.txt'))
    db = f'solvi_{prefix}_{build_token}_test'
    node = ['rtk', 'proxy', 'node', f'--env-file={ROOT / ".env"}']
    try:
        assert_free(web)
        assert_free(api)
        with ExitStack() as cleanup:
            def log(name):
                return cleanup.enter_context((out / f'{name}.log').open('w'))
            def start(args, name, **kwargs):
                proc = subprocess.Popen(args, stdout=log(name), stderr=subprocess.STDOUT, **kwargs)
                cleanup.callback(stop, proc)
                return proc
            with MIGRATION_LOCK:
                subprocess.run([*node, str(out / 'stack.mjs'), 'prepare', db], check=True, stdout=log('database'), stderr=subprocess.STDOUT)
            api_proc = start([*node, str(out / 'stack.mjs'), 'api', db], 'api')
            api_url = f'http://127.0.0.1:{api}'
            web_url = f'http://127.0.0.1:{web}'
            ready(api_url + '/readyz', api_proc)
            env = dict(os.environ, NODE_ENV='production', HOSTNAME='127.0.0.1', PORT=str(web),
                       NEXT_TELEMETRY_DISABLED='1', API_BASE_URL=api_url, WEB_BASE_URL=web_url,
                       S3_PUBLIC_ENDPOINT='http://127.0.0.1:9100')
            web_proc = start([*node, 'server.js'], 'web', cwd=build, env=env)
            ready(web_url + '/login', web_proc)
            results = str(out / 'results')
            if stage == '01':
                fixture = str(out / 'fixture.json')
                subprocess.run([*node, str(out / 'fixture.mjs'), db, fixture], check=True,
                               stdout=log('fixture'), stderr=subprocess.STDOUT)
                args = [fixture, results]
            elif stage in ('02', '03'):
                args = [results]
            elif stage in ('04', '05'):
                args = [results, '01']
            else:
                args = [results, db, '01']
            subprocess.run([*node, str(out / 'capture.mjs'), *args], check=True, timeout=240,
                           stdout=log('browser'), stderr=subprocess.STDOUT)
            supplementary = {'01': ('contrast', [str(out / 'contrast.json')]),
                             'visual': ('comparison', [results])}
            if stage in supplementary:
                script, params = supplementary[stage]
                if not (out / f'{script}.mjs').exists() and (patch_dir / f'{script}.mjs.txt').exists():
                    shutil.copyfile(patch_dir / f'{script}.mjs.txt', out / f'{script}.mjs')
                if (out / f'{script}.mjs').exists():
                    subprocess.run([*node, str(out / f'{script}.mjs'), *params], check=True, timeout=150,
                                   stdout=log(script), stderr=subprocess.STDOUT)
        print(stage, 'PASS', flush=True)
        return True
    except Exception as exc:
        print(stage, 'FAIL', exc, flush=True)
        return False

if __name__ == '__main__':
    build_name, label, *stages = sys.argv[1:]
    build = TMP / build_name / 'apps/web/.next/standalone'
    assert (build / 'server.js').exists()
    token = int(time.time())
    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(lambda stage: run(stage, build, label, token), stages or STAGES))
    raise SystemExit(0 if all(results) else 1)
