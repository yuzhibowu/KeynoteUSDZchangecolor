#!/usr/bin/env python3
"""规则扫描：只报告类型和位置，绝不输出疑似密钥内容。不是完整秘密检测器。"""
from pathlib import Path
import json
import re
import subprocess

PATTERNS = {
    'private-key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'provider-token': rb'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{30,})',
    'credential-url': rb'https?://[^\s/]+:[^\s/@]+@',
    'private-path': rb'(?:/' + rb'Users/[^/\s]+/|/ho' + rb'me/[^/\s]+/|[A-Z]:\\Users\\)',
    'secret-assignment': rb'(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[\x22\x27][^\x22\x27\n]{8,}',
}

def findings(data, location):
    return [{'type': name, **location} for name, pattern in PATTERNS.items() if re.search(pattern, data)]

history = []
large = []
count = 0
objects = subprocess.check_output(['git', 'rev-list', '--objects', '--all'], text=True).splitlines()
p = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
for line in objects:
    oid, _, name = line.partition(' ')
    p.stdin.write((oid + '\n').encode())
    p.stdin.flush()
    header = p.stdout.readline().decode().split()
    data = p.stdout.read(int(header[2]))
    p.stdout.read(1)
    if header[1] != 'blob':
        continue
    count += 1
    history.extend(findings(data, {'path': name, 'blob': oid[:12]}))
    if len(data) > 1_000_000:
        large.append({'path': name, 'bytes': len(data)})
p.stdin.close()
p.wait()
working = []
# 包括新建且未忽略的开源准备文件，不扫描 node_modules 或个人忽略素材。
files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).decode().split('\0')
for name in sorted(set(files)):
    f = Path(name)
    if name and f.is_file():
        working.extend(findings(f.read_bytes(), {'path': name}))
identities = set(subprocess.check_output(['git', 'log', '--all', '--format=%ae%n%ce'], text=True).splitlines())
report = {
    'scope': 'local reachable Git objects (--all) and tracked/unignored working files; no remote-only/deleted refs',
    'commits': int(subprocess.check_output(['git', 'rev-list', '--count', '--all'])),
    'reachable_blobs': count,
    'history_findings': history,
    'working_findings': working,
    'large_blobs': large,
    'author_identity_count': len(identities),
    'non_github_noreply_identity_count': sum(not email.endswith('@users.noreply.github.com') for email in identities),
    'local_hostname_identity_count': sum(email.endswith('.local') for email in identities),
    'limits': 'Heuristic patterns only; no entropy analysis, external secret scanner, LFS, remote logs or ignored private assets.',
}
print(json.dumps(report, ensure_ascii=False, indent=2))
