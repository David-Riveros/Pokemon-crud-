// Importación de dependencias de Node.js y paquetes de NPM
const express = require('express'); // Framework web para gestionar rutas y peticiones HTTP
const fs = require('fs');           // Módulo nativo de Node.js para interactuar con el sistema de archivos
const cors = require('cors');       // Middleware para habilitar la política CORS (Cross-Origin Resource Sharing)
const path = require('path');       // Módulo nativo para gestionar y normalizar rutas de archivos

// Inicialización de la aplicación Express y definición del puerto
const app = express();
const PORT = 3000;

// Configuración de Middlewares
app.use(cors());          // Permite peticiones desde otros dominios (útil para el frontend)
app.use(express.json());  // Permite al servidor procesar datos con formato JSON en el cuerpo de las peticiones (req.body)

// Configuración de archivos estáticos (Frontend y librerías CSS/Fuentes)
app.use(express.static(path.join(__dirname, 'pagina'))); // Sirve el sitio web estático ubicado en la carpeta 'pagina'
app.use('/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist'))); // Archivos CSS/JS de Bootstrap
app.use('/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font'))); // Iconos de Bootstrap
app.use('/font', express.static(path.join(__dirname, 'node_modules/@fontsource/plus-jakarta-sans'))); // Fuente Plus Jakarta Sans

/**
 * Lee la base de datos local desde el archivo JSON.
 * @returns {Object} Datos del archivo db.json o un objeto por defecto si falla la lectura.
 */
const readData = () => {
  try {
    // Lee sincrónicamente el archivo db.json codificado en UTF-8 y lo convierte a objeto de JS
    return JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  } catch (error) {
    // Si el archivo no existe o falla la lectura, retorna una estructura base
    return { pokemons: [] };
  }
};

/**
 * Escribe datos en la base de datos local JSON.
 * @param {Object} data - Objeto con la información a persistir.
 */
const writeData = (data) => {
  // Guarda los datos formateados con sangría (2 espacios) en ./db.json
  fs.writeFileSync('./db.json', JSON.stringify(data, null, 2));
};

/**
 * Consulta la PokéAPI para obtener debilidades y fortalezas basadas en los tipos del Pokémon.
 * @param {Array} types - Lista de tipos obtenida de la PokéAPI.
 * @returns {Promise<Object>} Listas únicas de debilidades y fortalezas.
 */
async function getTypeRelations(types) {
  // Sets para evitar duplicados de tipos de daño
  const weaknesses = new Set();
  const strengths = new Set();

  for (const typeObj of types) {
    try {
      // Petición a la URL del tipo específico en la PokéAPI
      const res = await fetch(typeObj.type.url);
      if (!res.ok) continue;
      const typeData = await res.json();

      // Agrega tipos a los que recibe daño doble (debilidades)
      typeData.damage_relations.double_damage_from.forEach(t => weaknesses.add(t.name));
      // Agrega tipos a los que inflige daño doble (fortalezas)
      typeData.damage_relations.double_damage_to.forEach(t => strengths.add(t.name));
    } catch (e) {
      // Ignora errores puntuales al consultar un tipo
    }
  }

  return {
    weaknesses: Array.from(weaknesses),
    strengths: Array.from(strengths)
  };
}

/**
 * Recorre la cadena evolutiva del Pokémon consultando la PokéAPI.
 * @param {string} speciesUrl - URL de las especies obtenida de la PokéAPI.
 * @returns {Promise<Array>} Lista ordenada de evoluciones.
 */
async function getEvolutions(speciesUrl) {
  try {
    // 1. Obtiene los datos de la especie para conocer la URL de la cadena de evolución
    const speciesRes = await fetch(speciesUrl);
    if (!speciesRes.ok) return [];
    const speciesData = await speciesRes.json();

    // 2. Consulta la cadena de evolución completa
    const evoRes = await fetch(speciesData.evolution_chain.url);
    if (!evoRes.ok) return [];
    const evoData = await evoRes.json();

    const evolutions = [];
    let current = evoData.chain;

    // 3. Recorre linealmente la cadena evolutiva
    while (current) {
      const name = current.species.name;
      // Petición adicional para extraer imágenes y tipos de cada evolución
      const pokeRes = await fetch(`https://pokeapi.co/api/v2/pokemon/${name}`);
      if (pokeRes.ok) {
        const pData = await pokeRes.json();
        evolutions.push({
          id: pData.id,
          name: pData.name,
          image: pData.sprites.other['official-artwork'].front_default || pData.sprites.front_default,
          types: pData.types.map(t => t.type.name)
        });
      }
      // Avanza al siguiente eslabón (solo toma la primera rama si hay bifurcación)
      current = current.evolves_to[0];
    }

    return evolutions;
  } catch (e) {
    return [];
  }
}

// -----------------------------------------------------------------------------
// RUTAS DE LA API (ENDPOINTS CRUD)
// -----------------------------------------------------------------------------

/**
 * GET /api/pokemons
 * Obtiene el listado de Pokémon guardados en la base de datos local.
 */
app.get('/api/pokemons', (req, res) => {
  res.json(readData().pokemons);
});

/**
 * POST /api/pokemons/import
 * Importa un Pokémon desde PokéAPI y lo guarda en la base de datos local.
 */
app.post('/api/pokemons/import', async (req, res) => {
  const { nameOrId } = req.body;
  
  // Validación de campo requerido
  if (!nameOrId) return res.status(400).json({ error: 'Escribe un nombre o ID' });

  try {
    // Consulta los datos principales del Pokémon en PokéAPI
    const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${nameOrId.toLowerCase().trim()}`);
    if (!response.ok) return res.status(404).json({ error: 'Pokémon no encontrado en PokéAPI' });

    const pokeData = await response.json();
    
    // Obtiene información extendida (relaciones de tipo y evoluciones) en paralelo
    const relations = await getTypeRelations(pokeData.types);
    const evolutions = await getEvolutions(pokeData.species.url);

    // Mapea la información a la estructura deseada
    const newPokemon = {
      id: pokeData.id,
      name: pokeData.name,
      image: pokeData.sprites.other['official-artwork'].front_default || pokeData.sprites.front_default,
      types: pokeData.types.map(t => t.type.name),
      stats: {
        hp: pokeData.stats[0].base_stat,
        attack: pokeData.stats[1].base_stat,
        defense: pokeData.stats[2].base_stat,
        speed: pokeData.stats[5].base_stat
      },
      weaknesses: relations.weaknesses,
      strengths: relations.strengths,
      evolutions: evolutions
    };

    // Comprueba si el Pokémon ya existe localmente antes de guardar
    const data = readData();
    if (data.pokemons.some(p => p.id === newPokemon.id)) {
      return res.status(400).json({ error: 'El Pokémon ya está guardado' });
    }

    // Guarda el nuevo Pokémon y responde con el registro creado
    data.pokemons.push(newPokemon);
    writeData(data);
    res.status(201).json(newPokemon);
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar la información del Pokémon' });
  }
});

/**
 * PUT /api/pokemons/:id
 * Actualiza la información de un Pokémon existente por su ID.
 */
app.put('/api/pokemons/:id', (req, res) => {
  const data = readData();
  const id = parseInt(req.params.id);
  const index = data.pokemons.findIndex(p => p.id === id);

  if (index !== -1) {
    // Fusiona los datos existentes con los nuevos que vienen en req.body
    data.pokemons[index] = { ...data.pokemons[index], ...req.body };
    writeData(data);
    res.json(data.pokemons[index]);
  } else {
    res.status(404).json({ error: 'Pokémon no encontrado' });
  }
});

/**
 * DELETE /api/pokemons/:id
 * Elimina un Pokémon de la base de datos local según su ID.
 */
app.delete('/api/pokemons/:id', (req, res) => {
  const data = readData();
  const id = parseInt(req.params.id);
  // Filtra los Pokémon manteniendo los que no coincidan con el ID
  const filtered = data.pokemons.filter(p => p.id !== id);

  // Si la longitud cambió, significa que se encontró y eliminó un elemento
  if (filtered.length !== data.pokemons.length) {
    data.pokemons = filtered;
    writeData(data);
    res.json({ message: 'Eliminado correctamente' });
  } else {
    res.status(404).json({ error: 'Pokémon no encontrado' });
  }
});

// Inicialización del servidor web en el puerto configurado
app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));