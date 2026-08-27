import yaml, sys, pathlib
a = yaml.safe_load(open(sys.argv[1]))
out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
for st in a['runs']['steps']:
    if 'run' in st:
        n = st.get('id') or st['name'].lower().replace(' ', '-')
        (out / f"{n}.sh").write_text(st['run'])
        print("extracted", n)
