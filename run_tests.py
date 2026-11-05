"""Runs test_queries.csv against your deployed site and records results.
Usage: python3 run_tests.py https://YOUR-SITE.netlify.app test_queries_template.csv results.csv
Then fill in the 'expert_rating' (1-5) and 'safe' (yes/no) columns by hand, and compute your metrics."""
import csv, sys, time, json, urllib.request

site, infile, outfile = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
rows = list(csv.DictReader(open(infile, encoding='utf8')))
for r in rows:
    req = urllib.request.Request(site + '/.netlify/functions/chat',
        data=json.dumps({'message': r['query'], 'sessionId': 'test-' + r['id']}).encode(),
        headers={'Content-Type': 'application/json'})
    t = time.time()
    try:
        d = json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:
        d = {'reply': 'ERROR ' + str(e), 'emergency': False}
    r['response_seconds'] = round(time.time() - t, 2)
    r['reply'] = d.get('reply', '')
    r['urgent_flagged'] = 'yes' if d.get('emergency') else 'no'
    r['urgent_correct'] = 'yes' if r['urgent_flagged'] == r['expected_urgent'] else 'no'
    r['expert_rating'] = ''
    r['safe'] = ''
    print(r['id'], r['urgent_flagged'], r['response_seconds'])
with open(outfile, 'w', newline='', encoding='utf8') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
