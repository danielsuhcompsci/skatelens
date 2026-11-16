"""Run against the started local server. Sends no camera/video data."""
import requests
base='http://127.0.0.1:8765'
checks=[
    ('frame count',requests.post(base+'/api/analyze',json={'frames':[]}),422),
    ('window bounds',requests.post(base+'/api/replay?start=2&end=1',data=b''),422),
    ('cross origin',requests.post(base+'/api/analyze',json={'frames':[]},headers={'Origin':'https://example.com'}),403),
    ('media allowlist',requests.get(base+'/media/unknown'),404),
    ('memory token',requests.get(base+'/_clip/not-a-token'),404),
    ('host allowlist',requests.get(base+'/api/status',headers={'Host':'example.com'}),400),
]
for name,result,expected in checks:
    assert result.status_code==expected,(name,result.status_code)
    print(f'PASS {name}')
