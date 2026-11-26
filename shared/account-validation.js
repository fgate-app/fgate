export const validUsername=value=>typeof value==='string' && /^[a-zA-Z0-9_.-]{3,40}$/.test(value);
export const validPassword=value=>typeof value==='string' && value.length>=12 && value.length<=256;
