"""Bounded stdin/stdout bridge; no network, files, or shell commands from input."""
import json
import sys


def generate():
    from rdkit import Chem
    from rdkit.Chem import AllChem

    payload = json.loads(sys.stdin.read(250_001))
    block = payload.get("molfile")
    if not isinstance(block, str) or len(block) > 200_000:
        raise ValueError("A valid Molfile is required for 3D generation.")
    mol = Chem.MolFromMolBlock(block, sanitize=True, removeHs=False)
    if mol is None or mol.GetNumAtoms() == 0:
        raise ValueError("This structure could not be read.")
    if mol.GetNumHeavyAtoms() > 200:
        raise ValueError("3D generation supports up to 200 non-hydrogen atoms.")
    if len(Chem.GetMolFrags(mol)) != 1:
        raise ValueError("View one connected molecule at a time in 3D.")
    unspecified = any(info.specified == Chem.StereoSpecified.Unspecified for info in Chem.FindPotentialStereo(mol))
    mol = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xC0DE
    params.enforceChirality = True
    params.maxIterations = 1000
    params.timeout = 15
    if AllChem.EmbedMolecule(mol, params) < 0:
        raise ValueError("A 3D conformer could not be generated for this structure.")
    warnings = []
    if AllChem.MMFFHasAllMoleculeParams(mol):
        status = AllChem.MMFFOptimizeMolecule(mol, maxIters=300)
        if status != 0:
            warnings.append("Geometry optimization did not converge; this is an approximate conformer.")
    elif AllChem.UFFHasAllMoleculeParams(mol):
        status = AllChem.UFFOptimizeMolecule(mol, maxIters=300)
        if status != 0:
            warnings.append("Geometry optimization did not converge; this is an approximate conformer.")
    else:
        warnings.append("No supported force field was available; this conformer has not been optimized.")
    if unspecified:
        warnings.append("Stereochemistry is unspecified at one or more positions; this model shows one possible arrangement.")
    # Assign stereo from the generated coordinates on a copy to verify every
    # originally specified tetrahedral center survived embedding/optimization.
    expected = {a.GetIdx(): a.GetProp("_CIPCode") for a in mol.GetAtoms() if a.HasProp("_CIPCode")}
    checked = Chem.Mol(mol)
    Chem.AssignStereochemistryFrom3D(checked, replaceExistingTags=True)
    Chem.AssignStereochemistry(checked, cleanIt=True, force=True)
    for idx, cip in expected.items():
        atom = checked.GetAtomWithIdx(idx)
        if not atom.HasProp("_CIPCode") or atom.GetProp("_CIPCode") != cip:
            raise ValueError("The generated conformer did not preserve the specified stereochemistry.")
    result = {"sdf": Chem.MolToMolBlock(mol) + "\n$$$$\n", "generated": True}
    if warnings:
        result["warning"] = " ".join(warnings)
    return result


try:
    print(json.dumps(generate()))
except ImportError:
    print(json.dumps({"error": "RDKit is missing from the local 3D helper. Run python3 scripts/setup-chemistry.py."}))
    sys.exit(2)
except Exception as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(1)
