MAIN=main

.PHONY: all clean dist

all:
	LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 latexmk -pdf -interaction=nonstopmode -halt-on-error $(MAIN).tex

clean:
	LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 latexmk -C $(MAIN).tex
	rm -f $(MAIN).bbl $(MAIN).run.xml $(MAIN).synctex.gz

dist: all
	rm -rf dist
	mkdir -p dist
	cp $(MAIN).tex references.bib neurips_2026.sty $(MAIN).bbl dist/
	LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 tar -czf papernexus-neurips2026-arxiv-source.tar.gz -C dist .
